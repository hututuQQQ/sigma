import { randomUUID } from "node:crypto";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { SigmaAcpEventForwarder } from "./sigma-acp-events.js";
import { SigmaAcpSessionRegistry } from "./sigma-acp-session-registry.js";
import {
  MODEL_CONFIG_ID,
  expectedAbort,
  listOffset,
  modelConfig,
  parseHealthRequest,
  parseSigmaTextCommand,
  promptText,
  sessionModes,
  stopReason,
  titleFromPrompt,
  type ForwardState,
  type PersistedAcpSession,
  type ResolvedSession,
  type SigmaAcpAgentOptions,
  type SigmaTextCommand
} from "./sigma-acp-shared.js";

export type {
  SigmaAcpAgentOptions,
  SigmaAcpModelCatalog,
  SigmaAcpModelOption,
  SigmaAcpRuntimeHandle
} from "./sigma-acp-shared.js";

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
        await resolved.handle.runtime.command({
          type: "cancel",
          sessionId: resolved.record.runtimeSessionId,
          reason: "ACP connection closed."
        }))
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
    const handle = await this.sessions.handle(cwd, catalog.currentModelId);
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
      configOptions: modelConfig(catalog, record.modelId)
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
      configOptions: modelConfig(catalog, resolved.record.modelId)
    };
  }

  private async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const resolved = await this.sessions.resolveSession(params.sessionId, params.cwd);
    await this.sessions.ensureAttached(resolved);
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    return {
      modes: sessionModes(resolved.record.mode),
      configOptions: modelConfig(catalog, resolved.record.modelId)
    };
  }

  private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwd = path.resolve(params.cwd ?? process.cwd());
    const catalog = await this.options.modelCatalog(cwd);
    const handle = await this.sessions.handle(cwd, catalog.currentModelId);
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
    const resolved = await this.sessions.resolveSession(params.sessionId);
    const controller = this.activePrompts.get(params.sessionId);
    if (controller) {
      controller.abort(new Error("ACP session closed."));
      await resolved.handle.runtime.command({
        type: "cancel",
        sessionId: resolved.record.runtimeSessionId,
        reason: "ACP session closed."
      });
    }
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

  private async setConfigOption(
    params: acp.SetSessionConfigOptionRequest
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (params.configId !== MODEL_CONFIG_ID || typeof params.value !== "string") {
      throw new Error(`Unsupported Sigma session configuration '${params.configId}'.`);
    }
    const resolved = await this.sessions.resolveSession(params.sessionId);
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    if (!catalog.options.some((option) => option.id === params.value)) {
      throw new Error(`Unknown Sigma model '${params.value}'.`);
    }
    if (params.value !== resolved.record.modelId) {
      if (resolved.record.started) {
        throw new Error("Sigma model can only be changed before the first prompt in a session.");
      }
      const replacement = await this.sessions.handle(resolved.record.cwd, params.value);
      const created = await replacement.runtime.createSession({
        workspacePath: replacement.workspace,
        mode: resolved.record.mode
      });
      await resolved.handle.runtime.releaseSession?.(resolved.record.runtimeSessionId);
      this.sessions.detach(resolved.record);
      resolved.record.runtimeSessionId = created.sessionId;
      resolved.record.modelId = params.value;
      resolved.record.cwd = replacement.workspace;
      resolved.record.lastSeq = 0;
      resolved.record.updatedAt = new Date().toISOString();
      this.sessions.markAttached(resolved.record);
      await this.sessions.upsert(replacement.storeRootDir, resolved.record);
    }
    return { configOptions: modelConfig(catalog, resolved.record.modelId) };
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

  private async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<acp.PromptResponse> {
    const text = promptText(params.prompt);
    if (this.activePrompts.has(params.sessionId)) {
      const resolved = await this.sessions.resolveSession(params.sessionId);
      await this.sessions.ensureAttached(resolved);
      await resolved.handle.runtime.command({
        type: "steer",
        sessionId: resolved.record.runtimeSessionId,
        text
      });
      return { stopReason: "end_turn", _meta: { "sigma.command": "steer" } };
    }
    const controller = new AbortController();
    this.activePrompts.set(params.sessionId, controller);
    let resolved: ResolvedSession | undefined;
    let forwarding: Promise<void> | undefined;
    const onRequestAbort = (): void => {
      controller.abort(signal.reason ?? new Error("ACP prompt request cancelled."));
      if (resolved) {
        void resolved.handle.runtime.command({
          type: "cancel",
          sessionId: resolved.record.runtimeSessionId,
          reason: "ACP prompt request cancelled."
        }).catch((error: unknown) => this.log(error));
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
      await this.dispatchPrompt(resolved, text, controller.signal);
      forwarding = this.events.forwardLive(resolved, client, state, controller.signal);
      const outcome = await Promise.race([
        resolved.handle.runtime.waitForOutcome(resolved.record.runtimeSessionId, controller.signal),
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
      return {
        stopReason: stopReason(outcome),
        _meta: {
          "sigma.outcome": outcome.kind,
          ...("message" in outcome ? { "sigma.message": outcome.message } : {})
        }
      };
    } catch (error) {
      if (expectedAbort(error, controller.signal)) return { stopReason: "cancelled" };
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
    const resolved = await this.sessions.resolveSession(params.sessionId);
    await resolved.handle.runtime.command({
      type: "cancel",
      sessionId: resolved.record.runtimeSessionId,
      reason: "Cancelled by ACP client."
    });
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
