import { randomUUID } from "node:crypto";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { ModelReasoningEffort } from "agent-model";
import { SigmaAcpEventForwarder } from "./sigma-acp-events.js";
import { SigmaAcpSessionRegistry } from "./sigma-acp-session-registry.js";
import {
  MODEL_CONFIG_ID,
  REASONING_EFFORT_CONFIG_ID,
  listOffset,
  modelConfig,
  reasoningEffortForModel,
  sessionModes,
  type ForwardState,
  type PersistedAcpSession,
  type SigmaAcpAgentOptions,
  type SigmaAcpModelCatalog
} from "./sigma-acp-shared.js";

interface SigmaSessionConfigSelection {
  currentReasoningEffort?: ModelReasoningEffort;
  nextModelId: string;
  nextReasoningEffort?: ModelReasoningEffort;
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
      nextReasoningEffort: reasoningEffortForModel(catalog, value, currentReasoningEffort)
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

export class SigmaAcpSessionService {
  constructor(
    private readonly options: SigmaAcpAgentOptions,
    private readonly sessions: SigmaAcpSessionRegistry,
    private readonly events: SigmaAcpEventForwarder,
    private readonly isPromptActive: (sessionId: string) => boolean
  ) {}

  async newSession(
    params: acp.NewSessionRequest,
    client: acp.AgentContext
  ): Promise<acp.NewSessionResponse> {
    const cwd = path.resolve(params.cwd);
    const catalog = await this.options.modelCatalog(cwd);
    const reasoningEffort = reasoningEffortForModel(catalog, catalog.currentModelId);
    const handle = await this.sessions.handle(
      cwd,
      catalog.currentModelId,
      reasoningEffort,
      params.mcpServers
    );
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
    this.sessions.bindMcpServers(record.sessionId, params.mcpServers);
    this.sessions.markAttached(record);
    await this.sessions.upsert(handle.storeRootDir, record);
    for (const server of params.mcpServers) {
      await this.events.forwardMcpStatus(record.sessionId, server, client, "connected");
    }
    return {
      sessionId: record.sessionId,
      modes: sessionModes(record.mode),
      configOptions: modelConfig(catalog, record.modelId, record.reasoningEffort)
    };
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext
  ): Promise<acp.LoadSessionResponse> {
    const resolved = await this.sessions.resolveSession(
      params.sessionId,
      params.cwd,
      params.mcpServers
    );
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

  async resumeSession(
    params: acp.ResumeSessionRequest,
    client: acp.AgentContext
  ): Promise<acp.ResumeSessionResponse> {
    const resolved = await this.sessions.resolveSession(
      params.sessionId,
      params.cwd,
      params.mcpServers
    );
    await this.sessions.ensureAttached(resolved);
    for (const server of params.mcpServers ?? []) {
      await this.events.forwardMcpStatus(params.sessionId, server, client, "connected");
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

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
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

  async setMode(params: acp.SetSessionModeRequest): Promise<void> {
    if (params.modeId !== "analyze" && params.modeId !== "change") {
      throw new Error(`Unsupported Sigma mode '${params.modeId}'.`);
    }
    const resolved = await this.sessions.resolveSession(params.sessionId);
    resolved.record.mode = params.modeId;
    resolved.record.updatedAt = new Date().toISOString();
    await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
  }

  async setConfigOption(
    params: acp.SetSessionConfigOptionRequest
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (
      (params.configId !== MODEL_CONFIG_ID && params.configId !== REASONING_EFFORT_CONFIG_ID)
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

  private async replaceSessionConfiguration(input: {
    resolved: import("./sigma-acp-shared.js").ResolvedSession;
    sessionId: string;
    nextModelId: string;
    nextReasoningEffort?: ModelReasoningEffort;
  }): Promise<void> {
    const { resolved, sessionId, nextModelId, nextReasoningEffort } = input;
    const modelChanged = nextModelId !== resolved.record.modelId;
    if (resolved.record.started && modelChanged) {
      throw new Error("Sigma model can only be changed before the first prompt in a session.");
    }
    if (resolved.record.started && this.isPromptActive(sessionId)) {
      throw new Error("Sigma reasoning effort cannot be changed while a prompt is running.");
    }
    const replacement = await this.sessions.handle(
      resolved.record.cwd,
      nextModelId,
      nextReasoningEffort,
      this.sessions.mcpServers(sessionId)
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
}
