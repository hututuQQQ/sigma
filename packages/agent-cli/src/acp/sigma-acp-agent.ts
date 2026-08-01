import { randomUUID } from "node:crypto";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { ModelReasoningEffort } from "agent-model";
import { SigmaAcpEventForwarder } from "./sigma-acp-events.js";
import { SigmaAcpSessionRegistry } from "./sigma-acp-session-registry.js";
import {
  cancellationReason,
  cancelResolvedSession
} from "./sigma-acp-cancellation.js";
import {
  MODEL_CONFIG_ID,
  REASONING_EFFORT_CONFIG_ID,
  SIGMA_RUNTIME_REQUEST_ERROR,
  expectedAbort,
  listOffset,
  modelConfig,
  parseHealthRequest,
  parseSigmaTextCommand,
  promptResponseForOutcome,
  promptText,
  reasoningEffortForModel,
  sessionModes,
  titleFromPrompt,
  type ForwardState,
  type PersistedAcpSession,
  type ResolvedSession,
  type SigmaAcpAgentOptions,
  type SigmaAcpModelCatalog,
  type SigmaTextCommand
} from "./sigma-acp-shared.js";

export type {
  SigmaAcpAgentOptions,
  SigmaAcpModelCatalog,
  SigmaAcpModelOption,
  SigmaAcpRuntimeHandle
} from "./sigma-acp-shared.js";

interface SigmaSessionConfigSelection {
  currentReasoningEffort?: ModelReasoningEffort;
  nextModelId: string;
  nextReasoningEffort?: ModelReasoningEffort;
}

class CheckpointRecoveryCancelled extends Error {}

function checkpointRecoveryDecision(
  response: acp.RequestPermissionResponse
): "keep" | "restore" | undefined {
  if (response.outcome.outcome !== "selected") return undefined;
  if (response.outcome.optionId === "keep" || response.outcome.optionId === "restore") {
    return response.outcome.optionId;
  }
  throw new Error(`Unknown checkpoint recovery option '${response.outcome.optionId}'.`);
}

function resolveSessionConfigSelection(
  configId: string,
  value: string,
  catalog: SigmaAcpModelCatalog,
  record: PersistedAcpSession
): SigmaSessionConfigSelection {
  const currentReasoningEffort = reasoningEffortForModel(
    catalog,
    record.modelId,
    record.reasoningEffort
  );
  if (configId === MODEL_CONFIG_ID) {
    if (!catalog.options.some((option) => option.id === value)) {
      throw new Error(`Unknown Sigma model '${value}'.`);
    }
    return {
      currentReasoningEffort,
      nextModelId: value,
      nextReasoningEffort: reasoningEffortForModel(
        catalog,
        value,
        currentReasoningEffort
      )
    };
  }
  const supported = catalog.options.find(
    (option) => option.id === record.modelId
  )?.supportedReasoningEfforts ?? [];
  if (!supported.includes(value as ModelReasoningEffort)) {
    throw new Error(
      `Unsupported Sigma reasoning effort '${value}' for model '${record.modelId}'.`
    );
  }
  return {
    currentReasoningEffort,
    nextModelId: record.modelId,
    nextReasoningEffort: value as ModelReasoningEffort
  };
}

export class SigmaAcpAgent {
  private readonly sessions: SigmaAcpSessionRegistry;
  private readonly events = new SigmaAcpEventForwarder();
  private readonly activePrompts = new Map<string, AbortController>();
  private readonly activeRuntimeSessions = new Map<string, ResolvedSession>();

  constructor(private readonly options: SigmaAcpAgentOptions) {
    this.sessions = new SigmaAcpSessionRegistry(options);
  }

  app(): acp.AgentApp {
    return acp.agent({ name: "sigma" })
      .onRequest(acp.methods.agent.initialize, () => this.initialize())
      .onRequest(acp.methods.agent.session.new, (context) => this.newSession(context.params))
      .onRequest(acp.methods.agent.session.load, (context) =>
        this.loadSession(context.params, context.client))
      .onRequest(acp.methods.agent.session.list, (context) => this.listSessions(context.params))
      .onRequest(acp.methods.agent.session.resume, (context) => this.resumeSession(context.params))
      .onRequest(acp.methods.agent.session.close, (context) => this.closeSession(context.params))
      .onRequest(acp.methods.agent.session.setMode, (context) => this.setMode(context.params))
      .onRequest(acp.methods.agent.session.setConfigOption, (context) =>
        this.setConfigOption(context.params))
      .onRequest(acp.methods.agent.session.prompt, (context) =>
        this.prompt(context.params, context.client, context.signal))
      .onNotification(acp.methods.agent.session.cancel, (context) => this.cancel(context.params))
      .onRequest("_sigma/steer", parseSigmaTextCommand, (context) => this.steer(context.params))
      .onRequest("_sigma/health", parseHealthRequest, () => ({
        ok: true,
        name: "Sigma",
        protocolVersion: acp.PROTOCOL_VERSION,
        version: this.options.agentVersion
      }));
  }

  async close(): Promise<void> {
    for (const controller of this.activePrompts.values()) {
      controller.abort(new Error("ACP connection closed."));
    }
    const cancellations = await Promise.allSettled(
      [...this.activeRuntimeSessions.values()].map(async (resolved) =>
        await cancelResolvedSession(resolved, "ACP connection closed."))
    );
    for (const result of cancellations) {
      if (result.status === "rejected") this.log(result.reason);
    }
    this.activePrompts.clear();
    this.activeRuntimeSessions.clear();
    await this.sessions.close();
  }

  private initialize(): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} }
      },
      agentInfo: {
        name: "Sigma",
        title: "Sigma Runtime",
        version: this.options.agentVersion
      }
    };
  }

  private async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const cwd = path.resolve(params.cwd);
    const catalog = await this.options.modelCatalog(cwd);
    const reasoningEffort = reasoningEffortForModel(catalog, catalog.currentModelId);
    const handle = await this.sessions.handle(cwd, catalog.currentModelId, reasoningEffort);
    const created = await handle.runtime.createSession({
      workspacePath: handle.workspace,
      mode: "change"
    });
    const now = new Date().toISOString();
    const record: PersistedAcpSession = {
      sessionId: `sigma-${randomUUID()}`,
      runtimeSessionId: created.sessionId,
      cwd: handle.workspace,
      modelId: catalog.currentModelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      mode: "change",
      createdAt: now,
      updatedAt: now,
      started: false,
      lastSeq: 0
    };
    this.sessions.markAttached(record);
    await this.sessions.upsert(handle.storeRootDir, record);
    return {
      sessionId: record.sessionId,
      modes: sessionModes(record.mode),
      configOptions: modelConfig(catalog, record.modelId, record.reasoningEffort)
    };
  }

  private async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext
  ): Promise<acp.LoadSessionResponse> {
    const resolved = await this.sessions.resolveSession(params.sessionId, params.cwd);
    await this.sessions.ensureAttached(resolved);
    const state: ForwardState = { modelText: new Map(), reasoningText: new Map() };
    for await (const event of resolved.handle.runtime.sessionEvents(resolved.record.runtimeSessionId)) {
      await this.events.forwardEvent(resolved, event, client, state, true);
    }
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    return {
      modes: sessionModes(resolved.record.mode),
      configOptions: modelConfig(
        catalog,
        resolved.record.modelId,
        resolved.record.reasoningEffort
      )
    };
  }

  private async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const resolved = await this.sessions.resolveSession(params.sessionId, params.cwd);
    await this.sessions.ensureAttached(resolved);
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    return {
      modes: sessionModes(resolved.record.mode),
      configOptions: modelConfig(
        catalog,
        resolved.record.modelId,
        resolved.record.reasoningEffort
      )
    };
  }

  private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwd = path.resolve(params.cwd ?? process.cwd());
    const catalog = await this.options.modelCatalog(cwd);
    const handle = await this.sessions.handle(
      cwd,
      catalog.currentModelId,
      reasoningEffortForModel(catalog, catalog.currentModelId)
    );
    const index = await this.sessions.index(handle.storeRootDir);
    const offset = listOffset(params.cursor);
    const nativeSessions = (await handle.runtime.listSessions(Number.MAX_SAFE_INTEGER))
      .filter((session) => path.resolve(session.workspacePath) === cwd);
    const nativeById = new Map(nativeSessions.map((session) => [session.sessionId, session]));
    const indexedRuntimeIds = new Set<string>();
    const matching = index.sessions
      .filter((record) => path.resolve(record.cwd) === cwd)
      .map((record) => {
        indexedRuntimeIds.add(record.runtimeSessionId);
        const native = nativeById.get(record.runtimeSessionId);
        return {
          sessionId: record.sessionId,
          cwd: record.cwd,
          ...(record.title || native?.lastMessage
            ? { title: record.title ?? native?.lastMessage?.slice(0, 96) }
            : {}),
          updatedAt: native && native.updatedAt > record.updatedAt
            ? native.updatedAt
            : record.updatedAt,
          _meta: {
            "sigma.runtimeSessionId": record.runtimeSessionId,
            "sigma.modelId": record.modelId
          }
        };
      });
    for (const native of nativeSessions) {
      if (indexedRuntimeIds.has(native.sessionId)) continue;
      matching.push({
        sessionId: native.sessionId,
        cwd: native.workspacePath,
        ...(native.lastMessage ? { title: native.lastMessage.slice(0, 96) } : {}),
        updatedAt: native.updatedAt,
        _meta: {
          "sigma.runtimeSessionId": native.sessionId,
          "sigma.modelId": catalog.currentModelId
        }
      });
    }
    matching.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const sessions = matching.slice(offset, offset + 50).map((record) => ({
      sessionId: record.sessionId,
      cwd: record.cwd,
      ...(record.title ? { title: record.title } : {}),
      updatedAt: record.updatedAt,
      _meta: record._meta
    }));
    const nextOffset = offset + sessions.length;
    return {
      sessions,
      ...(nextOffset < matching.length ? { nextCursor: `sigma:${nextOffset}` } : {})
    };
  }

  private async closeSession(params: acp.CloseSessionRequest): Promise<void> {
    const resolved = this.activeRuntimeSessions.get(params.sessionId)
      ?? await this.sessions.resolveSession(params.sessionId);
    const controller = this.activePrompts.get(params.sessionId);
    controller?.abort(new Error("ACP session closed."));
    await this.sessions.ensureAttached(resolved);
    await cancelResolvedSession(resolved, "ACP session closed.");
    await resolved.handle.runtime.releaseSession?.(resolved.record.runtimeSessionId);
    this.sessions.detach(resolved.record);
  }

  private async setMode(params: acp.SetSessionModeRequest): Promise<void> {
    if (params.modeId !== "analyze" && params.modeId !== "change") {
      throw new Error(`Unsupported Sigma mode '${params.modeId}'.`);
    }
    const resolved = await this.sessions.resolveSession(params.sessionId);
    resolved.record.mode = params.modeId;
    resolved.record.updatedAt = new Date().toISOString();
    await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
  }

  private async replaceSessionConfiguration(input: {
    resolved: ResolvedSession;
    sessionId: string;
    nextModelId: string;
    nextReasoningEffort?: ModelReasoningEffort;
  }): Promise<void> {
    const { resolved, sessionId, nextModelId, nextReasoningEffort } = input;
    const modelChanged = nextModelId !== resolved.record.modelId;
    if (resolved.record.started && modelChanged) {
      throw new Error("Sigma model can only be changed before the first prompt in a session.");
    }
    if (resolved.record.started && this.activePrompts.has(sessionId)) {
      throw new Error("Sigma reasoning effort cannot be changed while a prompt is running.");
    }
    const replacement = await this.sessions.handle(
      resolved.record.cwd,
      nextModelId,
      nextReasoningEffort
    );
    const created = resolved.record.started
      ? undefined
      : await replacement.runtime.createSession({
          workspacePath: replacement.workspace,
          mode: resolved.record.mode
        });
    if (resolved.record.started) {
      await replacement.runtime.command({
        type: "resume",
        sessionId: resolved.record.runtimeSessionId
      });
    }
    await resolved.handle.runtime.releaseSession?.(resolved.record.runtimeSessionId);
    this.sessions.detach(resolved.record);
    if (created) resolved.record.runtimeSessionId = created.sessionId;
    resolved.record.modelId = nextModelId;
    if (nextReasoningEffort) resolved.record.reasoningEffort = nextReasoningEffort;
    else delete resolved.record.reasoningEffort;
    resolved.record.cwd = replacement.workspace;
    if (created) resolved.record.lastSeq = 0;
    resolved.record.updatedAt = new Date().toISOString();
    this.sessions.markAttached(resolved.record);
    await this.sessions.upsert(replacement.storeRootDir, resolved.record);
  }

  private async setConfigOption(
    params: acp.SetSessionConfigOptionRequest
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (
      (params.configId !== MODEL_CONFIG_ID
        && params.configId !== REASONING_EFFORT_CONFIG_ID)
      || typeof params.value !== "string"
    ) {
      throw new Error(`Unsupported Sigma session configuration '${params.configId}'.`);
    }
    const resolved = await this.sessions.resolveSession(params.sessionId);
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    const selection = resolveSessionConfigSelection(
      params.configId,
      params.value,
      catalog,
      resolved.record
    );
    if (
      selection.nextModelId !== resolved.record.modelId
      || selection.nextReasoningEffort !== selection.currentReasoningEffort
    ) {
      await this.replaceSessionConfiguration({
        resolved,
        sessionId: params.sessionId,
        nextModelId: selection.nextModelId,
        ...(selection.nextReasoningEffort
          ? { nextReasoningEffort: selection.nextReasoningEffort }
          : {})
      });
    }
    return {
      configOptions: modelConfig(
        catalog,
        resolved.record.modelId,
        resolved.record.reasoningEffort
      )
    };
  }

  private async dispatchPrompt(
    resolved: ResolvedSession,
    text: string,
    signal: AbortSignal
  ): Promise<void> {
    const firstPrompt = !resolved.record.started;
    resolved.record.started = true;
    resolved.record.title ??= titleFromPrompt(text);
    resolved.record.updatedAt = new Date().toISOString();
    await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
    signal.throwIfAborted();
    await resolved.handle.runtime.command(firstPrompt
      ? {
          type: "submit",
          sessionId: resolved.record.runtimeSessionId,
          text,
          mode: resolved.record.mode
        }
      : {
          type: "follow_up",
          sessionId: resolved.record.runtimeSessionId,
          text
        });
  }

  private async pendingCheckpointRecovery(
    resolved: ResolvedSession
  ): Promise<{ checkpointId: string } | undefined> {
    return await resolved.handle.runtime.pendingCheckpointRecovery?.(
      resolved.record.runtimeSessionId
    );
  }

  private async resolveCheckpointRecovery(
    resolved: ResolvedSession,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<boolean> {
    const recovery = await this.pendingCheckpointRecovery(resolved);
    if (!recovery) return false;
    const response = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: resolved.record.sessionId,
      toolCall: {
        toolCallId: `checkpoint:${recovery.checkpointId}`,
        title: "Recover interrupted workspace changes",
        name: "checkpoint_recovery",
        kind: "edit",
        status: "pending",
        rawInput: { checkpointId: recovery.checkpointId }
      },
      options: [
        { optionId: "keep", name: "Keep current changes", kind: "allow_once" },
        { optionId: "restore", name: "Restore pre-interruption state", kind: "reject_once" }
      ],
      _meta: {
        "sigma.permission.requiresExplicitDecision": true,
        "sigma.checkpoint.id": recovery.checkpointId
      }
    }, { cancellationSignal: signal });
    const decision = checkpointRecoveryDecision(response);
    if (!decision) throw new CheckpointRecoveryCancelled("Checkpoint recovery was cancelled.");
    await resolved.handle.runtime.command({
      type: "checkpoint_recovery",
      sessionId: resolved.record.runtimeSessionId,
      checkpointId: recovery.checkpointId,
      decision
    });
    await resolved.handle.runtime.command({
      type: "resume",
      sessionId: resolved.record.runtimeSessionId
    });
    return true;
  }

  private async waitForPromptOutcome(
    resolved: ResolvedSession,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<import("agent-protocol").RunOutcome> {
    while (true) {
      const runtime = resolved.handle.runtime;
      const outcome = runtime.waitForIdleOutcome
        ? await runtime.waitForIdleOutcome(resolved.record.runtimeSessionId, signal)
        : await runtime.waitForOutcome(resolved.record.runtimeSessionId, signal);
      if (!await this.resolveCheckpointRecovery(resolved, client, signal)) return outcome;
    }
  }

  private async steerActivePrompt(
    sessionId: string,
    text: string
  ): Promise<acp.PromptResponse> {
    const resolved = await this.sessions.resolveSession(sessionId);
    await this.sessions.ensureAttached(resolved);
    await resolved.handle.runtime.command({
      type: "steer",
      sessionId: resolved.record.runtimeSessionId,
      text
    });
    return { stopReason: "end_turn", _meta: { "sigma.command": "steer" } };
  }

  private async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<acp.PromptResponse> {
    const text = promptText(params.prompt);
    if (this.activePrompts.has(params.sessionId)) {
      return await this.steerActivePrompt(params.sessionId, text);
    }
    const controller = new AbortController();
    this.activePrompts.set(params.sessionId, controller);
    let resolved: ResolvedSession | undefined;
    let forwarding: Promise<void> | undefined;
    const onRequestAbort = (): void => {
      controller.abort(signal.reason ?? new Error("ACP prompt request cancelled."));
      if (resolved) {
        void cancelResolvedSession(resolved, "ACP prompt request cancelled.")
          .catch((error: unknown) => this.log(error));
      }
    };
    if (signal.aborted) onRequestAbort();
    else signal.addEventListener("abort", onRequestAbort, { once: true });
    try {
      resolved = await this.sessions.resolveSession(params.sessionId);
      this.activeRuntimeSessions.set(params.sessionId, resolved);
      await this.sessions.ensureAttached(resolved);
      controller.signal.throwIfAborted();
      const state: ForwardState = { modelText: new Map(), reasoningText: new Map() };
      forwarding = this.events.forwardLive(resolved, client, state, controller.signal);
      // Observe stream rejection while recovery permission is still open.
      void forwarding.catch(() => undefined);
      await this.resolveCheckpointRecovery(resolved, client, controller.signal);
      await this.dispatchPrompt(resolved, text, controller.signal);
      const outcome = await Promise.race([
        this.waitForPromptOutcome(resolved, client, controller.signal),
        forwarding.then(() => {
          throw new Error("Sigma Runtime event stream ended before the run outcome.");
        })
      ]);
      controller.abort(new Error("Sigma Runtime turn completed."));
      await forwarding.catch((error: unknown) => {
        if (!expectedAbort(error, controller.signal)) throw error;
      });
      resolved.record.updatedAt = new Date().toISOString();
      await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
      return promptResponseForOutcome(outcome);
    } catch (error) {
      if (error instanceof acp.RequestError && error.code === SIGMA_RUNTIME_REQUEST_ERROR) throw error;
      if (error instanceof CheckpointRecoveryCancelled) {
        controller.abort(error);
        return { stopReason: "cancelled" };
      }
      if (expectedAbort(error, controller.signal)) {
        // Do not expose the cancelled prompt response until the runtime has
        // settled any in-flight mutation. The ACP cancel notification and the
        // prompt waiter run concurrently, so relying on the notification
        // handler alone leaves an acknowledgement/write race.
        if (resolved) {
          await cancelResolvedSession(
            resolved,
            cancellationReason(controller.signal, "ACP prompt request cancelled.")
          );
        }
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onRequestAbort);
      if (this.activePrompts.get(params.sessionId) === controller) {
        this.activePrompts.delete(params.sessionId);
        this.activeRuntimeSessions.delete(params.sessionId);
      }
      if (!controller.signal.aborted) controller.abort(new Error("Sigma ACP prompt finished."));
      if (forwarding) {
        await forwarding.catch((error: unknown) => {
          if (!expectedAbort(error, controller.signal)) this.log(error);
        });
      }
    }
  }

  private async cancel(params: acp.CancelNotification): Promise<void> {
    this.activePrompts.get(params.sessionId)?.abort(new Error("Cancelled by ACP client."));
    const resolved = this.activeRuntimeSessions.get(params.sessionId)
      ?? await this.sessions.resolveSession(params.sessionId);
    await this.sessions.ensureAttached(resolved);
    await cancelResolvedSession(resolved, "Cancelled by ACP client.");
  }

  private async steer(params: SigmaTextCommand): Promise<object> {
    const resolved = await this.sessions.resolveSession(params.sessionId);
    await this.sessions.ensureAttached(resolved);
    await resolved.handle.runtime.command({
      type: "steer",
      sessionId: resolved.record.runtimeSessionId,
      text: params.text
    });
    return {};
  }

  private log(error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    (this.options.stderr ?? process.stderr).write(`[sigma acp] ${message}\n`);
  }
}
