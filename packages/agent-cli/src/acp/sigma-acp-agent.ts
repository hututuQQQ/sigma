import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  isAgentEventOf,
  type AgentEventEnvelope,
  type AgentEventOf,
  type RunMode,
  type RunOutcome,
  type RuntimeClient
} from "agent-protocol";

const SESSION_INDEX_FILE = "acp-sessions.json";
const MODEL_CONFIG_ID = "sigma.model";
const INDEX_VERSION = 1;

export interface SigmaAcpRuntimeHandle {
  runtime: RuntimeClient;
  workspace: string;
  storeRootDir: string;
  close(): Promise<void>;
}

export interface SigmaAcpModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface SigmaAcpModelCatalog {
  currentModelId: string;
  options: SigmaAcpModelOption[];
}

export interface SigmaAcpAgentOptions {
  agentVersion: string;
  runtimeFactory(cwd: string, modelId: string): Promise<SigmaAcpRuntimeHandle>;
  modelCatalog(cwd: string): Promise<SigmaAcpModelCatalog>;
  stderr?: NodeJS.WritableStream;
}

interface PersistedAcpSession {
  sessionId: string;
  runtimeSessionId: string;
  cwd: string;
  modelId: string;
  mode: RunMode;
  title?: string;
  createdAt: string;
  updatedAt: string;
  started: boolean;
  lastSeq: number;
}

interface PersistedAcpIndex {
  version: typeof INDEX_VERSION;
  sessions: PersistedAcpSession[];
}

interface ResolvedSession {
  record: PersistedAcpSession;
  handle: SigmaAcpRuntimeHandle;
}

interface ForwardState {
  modelText: Map<number, string>;
  reasoningText: Map<number, string>;
}

interface SigmaTextCommand {
  sessionId: string;
  text: string;
}

function parseSigmaTextCommand(value: unknown): SigmaTextCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sigma ACP command params must be an object.");
  }
  const params = value as Record<string, unknown>;
  if (typeof params.sessionId !== "string" || !params.sessionId) {
    throw new Error("Sigma ACP command requires sessionId.");
  }
  if (typeof params.text !== "string" || !params.text) {
    throw new Error("Sigma ACP command requires text.");
  }
  return { sessionId: params.sessionId, text: params.text };
}

function parseHealthRequest(value: unknown): Record<string, never> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new Error("Sigma ACP health params must be empty.");
  }
  return {};
}

function sessionModes(mode: RunMode): acp.SessionModeState {
  return {
    currentModeId: mode,
    availableModes: [
      { id: "change", name: "Agent", description: "Analyze and modify the workspace." },
      { id: "analyze", name: "Plan", description: "Analyze the workspace without writes." }
    ]
  };
}

function modelConfig(catalog: SigmaAcpModelCatalog, currentModelId: string): acp.SessionConfigOption[] {
  return [{
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "Model used by Sigma Runtime.",
    category: "model",
    type: "select",
    currentValue: currentModelId,
    options: catalog.options.map((option) => ({
      value: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {})
    }))
  }];
}

function normalizeIndex(value: unknown): PersistedAcpIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: INDEX_VERSION, sessions: [] };
  }
  const input = value as Record<string, unknown>;
  if (input.version !== INDEX_VERSION || !Array.isArray(input.sessions)) {
    return { version: INDEX_VERSION, sessions: [] };
  }
  const sessions = input.sessions.filter((item): item is PersistedAcpSession => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.sessionId === "string"
      && typeof record.runtimeSessionId === "string"
      && typeof record.cwd === "string"
      && typeof record.modelId === "string"
      && (record.mode === "analyze" || record.mode === "change")
      && typeof record.createdAt === "string"
      && typeof record.updatedAt === "string"
      && typeof record.started === "boolean"
      && Number.isSafeInteger(record.lastSeq)
      && Number(record.lastSeq) >= 0;
  });
  return { version: INDEX_VERSION, sessions };
}

function promptText(prompt: acp.ContentBlock[]): string {
  const unsupported = prompt.find((block) => block.type !== "text");
  if (unsupported) {
    throw new Error(`Sigma ACP currently accepts text prompts; received '${unsupported.type}'.`);
  }
  const text = prompt.map((block) => block.type === "text" ? block.text : "").join("");
  if (!text) throw new Error("Sigma ACP prompt text must not be empty.");
  return text;
}

function titleFromPrompt(text: string): string {
  const firstLine = text.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
}

function listOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^sigma:(0|[1-9]\d*)$/u.exec(cursor);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset)) throw new Error(`Invalid Sigma session cursor '${cursor}'.`);
  return offset;
}

function toolKind(name: string, effects: readonly string[] = []): acp.ToolKind {
  if (effects.some((effect) => effect === "filesystem.write" || effect === "repository.write")) return "edit";
  if (effects.some((effect) => effect.startsWith("process."))) return "execute";
  if (effects.includes("network")) return "fetch";
  if (/search|find|grep/iu.test(name)) return "search";
  if (/read|list|inspect|status/iu.test(name)) return "read";
  return "other";
}

function textContent(text: string): acp.ToolCallContent[] {
  return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

function stopReason(outcome: RunOutcome): acp.StopReason {
  if (outcome.kind === "cancelled") return "cancelled";
  if (outcome.kind === "fatal" || outcome.kind === "recoverable_failure") return "refusal";
  return "end_turn";
}

function expectedAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  return error === signal.reason
    || (error instanceof Error && (error.name === "AbortError" || /cancel|abort/iu.test(error.message)));
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function approvalDecision(response: acp.RequestPermissionResponse): "allow" | "always_allow" | "deny" {
  if (response.outcome.outcome !== "selected") return "deny";
  if (response.outcome.optionId === "always_allow") return "always_allow";
  return response.outcome.optionId === "allow" ? "allow" : "deny";
}

export class SigmaAcpAgent {
  private readonly handles = new Map<string, Promise<SigmaAcpRuntimeHandle>>();
  private readonly indexes = new Map<string, PersistedAcpIndex>();
  private readonly indexWrites = new Map<string, Promise<void>>();
  private readonly sessionRoots = new Map<string, string>();
  private readonly attached = new Set<string>();
  private readonly activePrompts = new Map<string, AbortController>();
  private readonly activeRuntimeSessions = new Map<string, ResolvedSession>();

  constructor(private readonly options: SigmaAcpAgentOptions) {}

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
      .onRequest("_sigma/steer", parseSigmaTextCommand, (context) =>
        this.steer(context.params))
      .onRequest("_sigma/health", parseHealthRequest, () => ({
        ok: true,
        name: "Sigma",
        protocolVersion: acp.PROTOCOL_VERSION,
        version: this.options.agentVersion
      }));
  }

  async close(): Promise<void> {
    for (const controller of this.activePrompts.values()) controller.abort(new Error("ACP connection closed."));
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
    const handles = await Promise.allSettled(this.handles.values());
    await Promise.all(handles.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.close()] : []
    ));
    this.handles.clear();
  }

  private initialize(): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {}
        }
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
    const handle = await this.handle(cwd, catalog.currentModelId);
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
    this.attached.add(this.attachmentKey(record));
    await this.upsert(handle.storeRootDir, record);
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
    const resolved = await this.resolveSession(params.sessionId, params.cwd);
    await this.ensureAttached(resolved);
    const state: ForwardState = { modelText: new Map(), reasoningText: new Map() };
    for await (const event of resolved.handle.runtime.sessionEvents(resolved.record.runtimeSessionId)) {
      await this.forwardEvent(resolved, event, client, state, true);
    }
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    return {
      modes: sessionModes(resolved.record.mode),
      configOptions: modelConfig(catalog, resolved.record.modelId)
    };
  }

  private async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const resolved = await this.resolveSession(params.sessionId, params.cwd);
    await this.ensureAttached(resolved);
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    return {
      modes: sessionModes(resolved.record.mode),
      configOptions: modelConfig(catalog, resolved.record.modelId)
    };
  }

  private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwd = path.resolve(params.cwd ?? process.cwd());
    const catalog = await this.options.modelCatalog(cwd);
    const handle = await this.handle(cwd, catalog.currentModelId);
    const index = await this.index(handle.storeRootDir);
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
    const resolved = await this.resolveSession(params.sessionId);
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
    this.attached.delete(this.attachmentKey(resolved.record));
  }

  private async setMode(params: acp.SetSessionModeRequest): Promise<void> {
    if (params.modeId !== "analyze" && params.modeId !== "change") {
      throw new Error(`Unsupported Sigma mode '${params.modeId}'.`);
    }
    const resolved = await this.resolveSession(params.sessionId);
    resolved.record.mode = params.modeId;
    resolved.record.updatedAt = new Date().toISOString();
    await this.upsert(resolved.handle.storeRootDir, resolved.record);
  }

  private async setConfigOption(
    params: acp.SetSessionConfigOptionRequest
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (params.configId !== MODEL_CONFIG_ID || typeof params.value !== "string") {
      throw new Error(`Unsupported Sigma session configuration '${params.configId}'.`);
    }
    const resolved = await this.resolveSession(params.sessionId);
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    if (!catalog.options.some((option) => option.id === params.value)) {
      throw new Error(`Unknown Sigma model '${params.value}'.`);
    }
    if (params.value !== resolved.record.modelId) {
      if (resolved.record.started) {
        throw new Error("Sigma model can only be changed before the first prompt in a session.");
      }
      const replacement = await this.handle(resolved.record.cwd, params.value);
      const created = await replacement.runtime.createSession({
        workspacePath: replacement.workspace,
        mode: resolved.record.mode
      });
      await resolved.handle.runtime.releaseSession?.(resolved.record.runtimeSessionId);
      this.attached.delete(this.attachmentKey(resolved.record));
      resolved.record.runtimeSessionId = created.sessionId;
      resolved.record.modelId = params.value;
      resolved.record.cwd = replacement.workspace;
      resolved.record.lastSeq = 0;
      resolved.record.updatedAt = new Date().toISOString();
      this.attached.add(this.attachmentKey(resolved.record));
      await this.upsert(replacement.storeRootDir, resolved.record);
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
    await this.upsert(resolved.handle.storeRootDir, resolved.record);
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
      const resolved = await this.resolveSession(params.sessionId);
      await this.ensureAttached(resolved);
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
      resolved = await this.resolveSession(params.sessionId);
      this.activeRuntimeSessions.set(params.sessionId, resolved);
      await this.ensureAttached(resolved);
      controller.signal.throwIfAborted();
      const state: ForwardState = { modelText: new Map(), reasoningText: new Map() };
      await this.dispatchPrompt(resolved, text, controller.signal);
      forwarding = this.forwardLive(resolved, client, state, controller.signal);
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
      await this.upsert(resolved.handle.storeRootDir, resolved.record);
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
    const resolved = await this.resolveSession(params.sessionId);
    await resolved.handle.runtime.command({
      type: "cancel",
      sessionId: resolved.record.runtimeSessionId,
      reason: "Cancelled by ACP client."
    });
  }

  private async steer(params: SigmaTextCommand): Promise<object> {
    const resolved = await this.resolveSession(params.sessionId);
    await this.ensureAttached(resolved);
    await resolved.handle.runtime.command({
      type: "steer",
      sessionId: resolved.record.runtimeSessionId,
      text: params.text
    });
    return {};
  }

  private async forwardLive(
    resolved: ResolvedSession,
    client: acp.AgentContext,
    state: ForwardState,
    signal: AbortSignal
  ): Promise<void> {
    for await (const event of resolved.handle.runtime.subscribe(
      resolved.record.runtimeSessionId,
      signal
    )) {
      if (event.seq <= resolved.record.lastSeq) continue;
      await this.forwardEvent(resolved, event, client, state, false, signal);
      resolved.record.lastSeq = event.seq;
    }
  }

  private async forwardEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    state: ForwardState,
    replay: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (await this.forwardUserEvent(resolved, event, client, replay)) return;
    if (await this.forwardModelEvent(resolved, event, client, state, replay)) return;
    if (await this.forwardPlanEvent(resolved, event, client, replay)) return;
    if (await this.forwardToolRequestEvent(resolved, event, client, replay, signal)) return;
    await this.forwardToolResultEvent(resolved, event, client, replay);
  }

  private async forwardUserEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "user.message") || isAgentEventOf(event, "user.steer")) {
      if (replay) await this.notify(client, sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: event.payload.text }
      }, true);
      return true;
    }
    if (!isAgentEventOf(event, "user.follow_up")) return false;
    if (replay && event.payload.status === "delivered") {
      await this.notify(client, sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: event.payload.text }
      }, true);
    }
    return true;
  }

  private async forwardModelEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    state: ForwardState,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "model.delta")) {
      state.modelText.set(
        event.payload.turnId,
        `${state.modelText.get(event.payload.turnId) ?? ""}${event.payload.delta}`
      );
      await this.notify(client, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.payload.delta }
      }, replay);
      return true;
    }
    if (isAgentEventOf(event, "model.reasoning_delta")) {
      state.reasoningText.set(
        event.payload.turnId,
        `${state.reasoningText.get(event.payload.turnId) ?? ""}${event.payload.delta}`
      );
      await this.notify(client, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.payload.delta }
      }, replay);
      return true;
    }
    if (!isAgentEventOf(event, "model.completed")) return false;
    const streamed = state.modelText.get(event.payload.turnId) ?? "";
    const remaining = event.payload.text.startsWith(streamed)
      ? event.payload.text.slice(streamed.length)
      : streamed ? "" : event.payload.text;
    if (remaining) await this.notify(client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: remaining }
    }, replay);
    const reasoning = event.payload.message.reasoningContent ?? "";
    const streamedReasoning = state.reasoningText.get(event.payload.turnId) ?? "";
    const reasoningRemaining = reasoning.startsWith(streamedReasoning)
      ? reasoning.slice(streamedReasoning.length)
      : streamedReasoning ? "" : reasoning;
    if (reasoningRemaining) await this.notify(client, sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: reasoningRemaining }
    }, replay);
    state.modelText.delete(event.payload.turnId);
    state.reasoningText.delete(event.payload.turnId);
    return true;
  }

  private async forwardPlanEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    if (!isAgentEventOf(event, "plan.updated")) return false;
    await this.notify(client, resolved.record.sessionId, {
      sessionUpdate: "plan",
      entries: event.payload.plan.nodes.map((node) => ({
        content: node.title,
        priority: event.payload.plan.activeNodeId === node.id ? "high" : "medium",
        status: node.status === "completed"
          ? "completed"
          : node.status === "in_progress" ? "in_progress" : "pending",
        _meta: {
          "sigma.nodeId": node.id,
          "sigma.status": node.status,
          "sigma.dependencies": node.dependencies
        }
      }))
    }, replay);
    return true;
  }

  private async forwardToolRequestEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "tool.requested")) {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.payload.callId,
        title: event.payload.name,
        name: event.payload.name,
        kind: toolKind(event.payload.name),
        status: "pending",
        rawInput: event.payload.arguments
      }, replay);
      return true;
    }
    if (!isAgentEventOf(event, "tool.approval_requested")) return false;
    const effects = event.payload.effects;
    await this.notify(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.payload.callId,
      title: event.payload.toolName,
      name: event.payload.toolName,
      kind: toolKind(event.payload.toolName, effects),
      status: "pending",
      rawInput: event.payload.arguments,
      rawOutput: { approvalReason: event.payload.reason, effects }
    }, replay);
    if (!replay && event.payload.approvalMode === "human" && event.payload.delegated !== true) {
      if (!signal) throw new Error("Live Sigma approval forwarding requires an abort signal.");
      await this.requestToolApproval(resolved, event, client, signal);
    }
    return true;
  }

  private async requestToolApproval(
    resolved: ResolvedSession,
    event: AgentEventOf<"tool.approval_requested">,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<void> {
    const effects = event.payload.effects;
    const request = client.request(acp.methods.client.session.requestPermission, {
      sessionId: resolved.record.sessionId,
      toolCall: {
        toolCallId: event.payload.callId,
        title: event.payload.toolName,
        name: event.payload.toolName,
        kind: toolKind(event.payload.toolName, effects),
        status: "pending",
        rawInput: event.payload.arguments
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "always_allow", name: "Always allow this tool", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" }
      ]
    }, { cancellationSignal: signal });
    const permission = await abortable(request, signal);
    await resolved.handle.runtime.command({
      type: "approve",
      sessionId: resolved.record.runtimeSessionId,
      requestId: event.payload.requestId,
      decision: approvalDecision(permission)
    });
  }

  private async forwardToolResultEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "tool.started")) {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.callId,
        title: event.payload.name,
        name: event.payload.name,
        kind: toolKind(event.payload.name),
        status: "in_progress"
      }, replay);
      return true;
    }
    if (isAgentEventOf(event, "tool.progress")) {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.callId,
        title: event.payload.name,
        name: event.payload.name,
        status: "in_progress",
        content: textContent(event.payload.message),
        rawOutput: {
          message: event.payload.message,
          ...(event.payload.percent === undefined ? {} : { percent: event.payload.percent })
        }
      }, replay);
      return true;
    }
    if (!isAgentEventOf(event, "tool.completed") && !isAgentEventOf(event, "tool.failed")) return false;
    await this.notify(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.payload.callId,
      title: event.payload.name,
      name: event.payload.name,
      status: event.type === "tool.completed" ? "completed" : "failed",
      content: textContent(event.payload.output),
      rawOutput: {
        ok: event.payload.ok,
        output: event.payload.output,
        outcome: event.payload.outcome,
        ...(event.payload.result === undefined ? {} : { result: event.payload.result }),
        diagnostics: event.payload.diagnostics
      }
    }, replay);
    return true;
  }

  private async notify(
    client: acp.AgentContext,
    sessionId: string,
    update: acp.SessionUpdate,
    replay: boolean
  ): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update,
      ...(replay ? { _meta: { isReplay: true } } : {})
    });
  }

  private async resolveSession(sessionId: string, cwdHint?: string): Promise<ResolvedSession> {
    const knownRoot = cwdHint ? undefined : this.sessionRoots.get(sessionId);
    if (knownRoot) {
      const knownIndex = await this.index(knownRoot);
      const knownRecord = knownIndex.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (knownRecord) {
        return {
          record: knownRecord,
          handle: await this.handle(knownRecord.cwd, knownRecord.modelId)
        };
      }
    }
    const cwd = path.resolve(cwdHint ?? process.cwd());
    const catalog = await this.options.modelCatalog(cwd);
    const defaultHandle = await this.handle(cwd, catalog.currentModelId);
    const index = await this.index(defaultHandle.storeRootDir);
    let record = index.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!record) {
      const native = (await defaultHandle.runtime.listSessions(Number.MAX_SAFE_INTEGER))
        .find((candidate) => candidate.sessionId === sessionId);
      if (!native) throw new Error(`Unknown Sigma ACP session '${sessionId}'.`);
      record = {
        sessionId,
        runtimeSessionId: sessionId,
        cwd: native.workspacePath,
        modelId: catalog.currentModelId,
        mode: native.mode,
        ...(native.lastMessage ? { title: native.lastMessage.slice(0, 96) } : {}),
        createdAt: native.updatedAt,
        updatedAt: native.updatedAt,
        started: native.lastSeq > 1,
        lastSeq: native.lastSeq
      };
      await this.upsert(defaultHandle.storeRootDir, record);
    }
    if (cwdHint && path.resolve(record.cwd) !== cwd) {
      throw new Error(`Sigma ACP session '${sessionId}' belongs to '${record.cwd}', not '${cwd}'.`);
    }
    return {
      record,
      handle: record.modelId === catalog.currentModelId
        ? defaultHandle
        : await this.handle(record.cwd, record.modelId)
    };
  }

  private async ensureAttached(resolved: ResolvedSession): Promise<void> {
    const key = this.attachmentKey(resolved.record);
    if (this.attached.has(key)) return;
    await resolved.handle.runtime.command({
      type: "resume",
      sessionId: resolved.record.runtimeSessionId
    });
    this.attached.add(key);
  }

  private attachmentKey(record: PersistedAcpSession): string {
    return `${record.modelId}\0${record.runtimeSessionId}`;
  }

  private handle(cwd: string, modelId: string): Promise<SigmaAcpRuntimeHandle> {
    const key = `${path.resolve(cwd)}\0${modelId}`;
    let handle = this.handles.get(key);
    if (!handle) {
      handle = this.options.runtimeFactory(path.resolve(cwd), modelId);
      this.handles.set(key, handle);
      void handle.catch(() => this.handles.delete(key));
    }
    return handle;
  }

  private async index(storeRootDir: string): Promise<PersistedAcpIndex> {
    const key = path.resolve(storeRootDir);
    const cached = this.indexes.get(key);
    if (cached) return cached;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(key, SESSION_INDEX_FILE), "utf8")) as unknown;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const index = normalizeIndex(value);
    this.indexes.set(key, index);
    for (const record of index.sessions) this.sessionRoots.set(record.sessionId, key);
    return index;
  }

  private async upsert(storeRootDir: string, record: PersistedAcpSession): Promise<void> {
    const root = path.resolve(storeRootDir);
    const previous = this.indexWrites.get(root) ?? Promise.resolve();
    const write = previous.then(async () => {
      const index = await this.index(root);
      const existing = index.sessions.findIndex((candidate) => candidate.sessionId === record.sessionId);
      const snapshot = { ...record };
      if (existing >= 0) index.sessions[existing] = snapshot;
      else index.sessions.push(snapshot);
      this.sessionRoots.set(record.sessionId, root);
      await mkdir(root, { recursive: true });
      const target = path.join(root, SESSION_INDEX_FILE);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    });
    this.indexWrites.set(root, write);
    try {
      await write;
    } finally {
      if (this.indexWrites.get(root) === write) this.indexWrites.delete(root);
    }
  }

  private log(error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    (this.options.stderr ?? process.stderr).write(`[sigma acp] ${message}\n`);
  }
}
