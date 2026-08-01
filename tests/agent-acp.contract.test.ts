import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentEventEnvelope,
  RunCommand,
  RunOutcome,
  RuntimeClient,
  SessionOverview,
  SessionRef,
  StartSession
} from "agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runAcpCommand } from "../packages/agent-cli/src/commands/acp.js";
import { SigmaAcpSessionRegistry } from "../packages/agent-cli/src/acp/sigma-acp-session-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true })
  ));
});

function envelope(
  sessionId: string,
  runId: string,
  seq: number,
  type: AgentEventEnvelope["type"],
  payload: unknown
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    seq,
    eventId: `event-${seq}`,
    sessionId,
    runId,
    occurredAt: new Date().toISOString(),
    type,
    authority: type.startsWith("tool.") ? "tool" : "runtime",
    payload
  };
}

class FakeRuntime implements RuntimeClient {
  readonly commands: RunCommand[] = [];
  readonly releasedSessions: string[] = [];
  cancelSettlement?: { started(): void; wait: Promise<void> };
  resumeSettlement?: { started(): void; wait: Promise<void> };
  private readonly attached = new Set<string>();
  private readonly requireAttachmentForCancel = new Set<string>();
  private readonly events: AgentEventEnvelope[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private readonly outcomes = new Map<string, RunOutcome>();
  private readonly outcomeWaiters = new Map<string, Set<(outcome: RunOutcome) => void>>();
  private readonly sessions = new Map<string, SessionOverview>();
  private readonly approvals = new Map<string, (decision: string) => void>();
  private readonly checkpointRecoveries = new Map<string, string>();
  private nextSession = 0;

  async createSession(input: StartSession): Promise<SessionRef> {
    const sessionId = `runtime-${++this.nextSession}`;
    const runId = `run-${this.nextSession}`;
    this.sessions.set(sessionId, {
      sessionId,
      workspacePath: input.workspacePath,
      mode: input.mode,
      status: "idle",
      updatedAt: new Date().toISOString(),
      lastSeq: 0
    });
    return { sessionId, runId };
  }

  async command(command: RunCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "resume") {
      this.resumeSettlement?.started();
      await this.resumeSettlement?.wait;
      this.attached.add(command.sessionId);
      return;
    }
    if (command.type === "checkpoint_recovery") {
      const checkpointId = this.checkpointRecoveries.get(command.sessionId);
      if (checkpointId !== command.checkpointId) {
        throw new Error(`Unknown fake checkpoint '${command.checkpointId}'.`);
      }
      this.checkpointRecoveries.delete(command.sessionId);
      return;
    }
    if (command.type === "submit" || command.type === "follow_up") {
      const overview = this.required(command.sessionId);
      overview.status = "running";
      if (command.type === "submit") overview.mode = command.mode ?? overview.mode;
      overview.updatedAt = new Date().toISOString();
      this.outcomes.delete(command.sessionId);
      if (command.text === "wait for cancellation") {
        this.emit(command.sessionId, "model.reasoning_delta", { turnId: 2, delta: "Waiting." });
        return;
      }
      if (command.text === "fail provider") {
        this.finish(command.sessionId, {
          kind: "recoverable_failure",
          code: "server",
          message: "The model provider is temporarily unavailable."
        });
        return;
      }
      void this.completeTurn(command.sessionId);
      return;
    }
    if (command.type === "approve") {
      this.approvals.get(command.requestId)?.(command.decision);
      return;
    }
    if (command.type === "cancel") {
      if (this.requireAttachmentForCancel.has(command.sessionId)
        && !this.attached.has(command.sessionId)) {
        throw new Error(`Unknown fake session '${command.sessionId}' until resume.`);
      }
      this.cancelSettlement?.started();
      await this.cancelSettlement?.wait;
      this.finish(command.sessionId, { kind: "cancelled", reason: command.reason ?? "cancelled" });
    }
  }

  async *subscribe(sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    let offset = 0;
    while (true) {
      while (offset < this.events.length) {
        const event = this.events[offset++];
        if (event?.sessionId === sessionId) yield event;
      }
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", abort);
          this.eventWaiters.delete(wake);
          resolve();
        };
        const abort = (): void => {
          this.eventWaiters.delete(wake);
          reject(signal?.reason ?? new Error("aborted"));
        };
        this.eventWaiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  async waitForOutcome(sessionId: string, signal?: AbortSignal): Promise<RunOutcome> {
    const outcome = this.outcomes.get(sessionId);
    if (outcome) return outcome;
    return await new Promise<RunOutcome>((resolve, reject) => {
      const waiters = this.outcomeWaiters.get(sessionId) ?? new Set();
      const settle = (value: RunOutcome): void => {
        signal?.removeEventListener("abort", abort);
        waiters.delete(settle);
        resolve(value);
      };
      const abort = (): void => {
        waiters.delete(settle);
        reject(signal?.reason ?? new Error("aborted"));
      };
      waiters.add(settle);
      this.outcomeWaiters.set(sessionId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async pendingCheckpointRecovery(
    sessionId: string
  ): Promise<{ checkpointId: string } | undefined> {
    const checkpointId = this.checkpointRecoveries.get(sessionId);
    return checkpointId ? { checkpointId } : undefined;
  }

  async listSessions(): Promise<SessionOverview[]> {
    return [...this.sessions.values()];
  }

  async *sessionEvents(sessionId: string, afterSeq = 0): AsyncIterable<AgentEventEnvelope> {
    for (const event of this.events) {
      if (event.sessionId === sessionId && event.seq > afterSeq) yield event;
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    this.releasedSessions.push(sessionId);
  }

  seedHistory(sessionId: string, text: string): void {
    this.emit(sessionId, "user.message", { text });
    this.emit(sessionId, "model.delta", { turnId: 1, delta: "Stored response." });
    const overview = this.required(sessionId);
    overview.status = "completed";
    overview.lastMessage = text;
    this.outcomes.set(sessionId, { kind: "completed", message: "Stored response.", evidence: [] });
  }

  seedCheckpointRecovery(sessionId: string, checkpointId: string): void {
    this.checkpointRecoveries.set(sessionId, checkpointId);
  }

  latestSessionId(): string {
    return `runtime-${this.nextSession}`;
  }

  requireResumeBeforeCancel(sessionId: string): void {
    this.requireAttachmentForCancel.add(sessionId);
  }

  private async completeTurn(sessionId: string): Promise<void> {
    const runId = `active-${sessionId}`;
    this.emit(sessionId, "model.reasoning_delta", { turnId: 1, delta: "Inspecting the workspace. " }, runId);
    this.emit(sessionId, "model.delta", { turnId: 1, delta: "I will update the file. " }, runId);
    this.emit(sessionId, "plan.updated", {
      previousRevision: 0,
      plan: {
        revision: 1,
        goal: "Update a file",
        activeNodeId: "edit",
        nodes: [{
          id: "edit",
          title: "Edit README",
          dependencies: [],
          status: "in_progress",
          owner: { kind: "root" },
          acceptanceCriteria: ["README updated"],
          evidence: []
        }]
      }
    }, runId);
    this.emit(sessionId, "tool.requested", {
      callId: "tool-1",
      name: "write_file",
      arguments: { path: "README.md", content: "Sigma" },
      turnId: 1,
      effectRevision: 0
    }, runId);
    const decision = new Promise<string>((resolve) => this.approvals.set("approval-1", resolve));
    this.emit(sessionId, "tool.approval_requested", {
      requestId: "approval-1",
      callId: "tool-1",
      toolName: "write_file",
      arguments: { path: "README.md", content: "Sigma" },
      effects: ["filesystem.write"],
      plan: {
        exactEffects: ["filesystem.write"],
        readPaths: [],
        writePaths: ["README.md"],
        network: "none",
        processMode: "none",
        checkpointScope: ["README.md"],
        idempotence: "replay_safe"
      },
      reason: "Writing README requires approval.",
      approvalMode: "human",
      turnId: 1,
      effectRevision: 0
    }, runId);
    if (await decision === "deny") {
      this.finish(sessionId, { kind: "cancelled", reason: "tool denied" });
      return;
    }
    this.emit(sessionId, "tool.started", {
      callId: "tool-1",
      name: "write_file",
      turnId: 1,
      effectRevision: 0
    }, runId);
    this.emit(sessionId, "tool.progress", {
      callId: "tool-1",
      name: "write_file",
      turnId: 1,
      effectRevision: 0,
      message: "Writing README",
      percent: 50
    }, runId);
    const now = new Date().toISOString();
    this.emit(sessionId, "tool.completed", {
      callId: "tool-1",
      name: "write_file",
      ok: true,
      output: "README updated",
      result: { path: "README.md" },
      outcome: { status: "succeeded", output: "README updated", diagnosticCodes: [] },
      observedEffects: ["filesystem.write"],
      actualEffects: ["filesystem.write"],
      artifacts: [],
      diagnostics: [],
      evidence: [],
      startedAt: now,
      completedAt: now,
      turnId: 1,
      effectRevision: 0
    }, runId);
    this.emit(sessionId, "model.delta", { turnId: 1, delta: "Done." }, runId);
    this.emit(sessionId, "model.completed", {
      model: "fake-model",
      turnId: 1,
      effectRevision: 0,
      text: "I will update the file. Done.",
      finishReason: "stop",
      message: {
        role: "assistant",
        content: "I will update the file. Done.",
        reasoningContent: "Inspecting the workspace. "
      },
      toolCalls: [],
      usage: {
        usageId: "usage-1",
        requestId: "request-1",
        sessionId,
        runId,
        role: "root",
        routeId: "default",
        providerId: "fake",
        modelId: "fake-model",
        tokenizerId: "fake",
        tokenizerAccuracy: "exact",
        providerReported: true,
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 0,
        latencyMs: 1,
        attempt: 1,
        occurredAt: now
      }
    }, runId);
    this.finish(sessionId, { kind: "completed", message: "Done.", evidence: [] });
  }

  private emit(sessionId: string, type: AgentEventEnvelope["type"], payload: unknown, runId?: string): void {
    const event = envelope(sessionId, runId ?? `active-${sessionId}`, this.events.length + 1, type, payload);
    this.events.push(event);
    const overview = this.required(sessionId);
    overview.lastSeq = event.seq;
    overview.updatedAt = event.occurredAt;
    for (const wake of [...this.eventWaiters]) wake();
  }

  private finish(sessionId: string, outcome: RunOutcome): void {
    this.outcomes.set(sessionId, outcome);
    const overview = this.required(sessionId);
    overview.status = outcome.kind === "completed"
      ? "completed"
      : outcome.kind === "cancelled" ? "cancelled" : "failed";
    for (const resolve of this.outcomeWaiters.get(sessionId) ?? []) resolve(outcome);
    this.outcomeWaiters.delete(sessionId);
  }

  private required(sessionId: string): SessionOverview {
    const overview = this.sessions.get(sessionId);
    if (!overview) throw new Error(`Unknown fake session '${sessionId}'.`);
    return overview;
  }
}

describe("Sigma ACP v1 contract", () => {
  it("rejects unsupported and malformed session indexes without rewriting them", async () => {
    const options = {
      agentVersion: "test",
      runtimeFactory: async (): Promise<never> => {
        throw new Error("Runtime must not start while reading an invalid index.");
      },
      modelCatalog: async () => ({ currentModelId: "test/model", options: [] })
    };
    const unsupportedRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-acp-index-version-"));
    temporaryDirectories.push(unsupportedRoot);
    await mkdir(unsupportedRoot, { recursive: true });
    const unsupportedPath = path.join(unsupportedRoot, "acp-sessions.json");
    const unsupported = `${JSON.stringify({
      version: 2,
      sessions: [{ secret: "unsupported-session-record" }]
    })}\n`;
    await writeFile(unsupportedPath, unsupported, "utf8");

    await expect(new SigmaAcpSessionRegistry(options).index(unsupportedRoot))
      .rejects.toMatchObject({
        code: "unsupported_schema_version",
        path: unsupportedPath,
        expected: 1,
        actual: 2
      });
    expect(await readFile(unsupportedPath, "utf8")).toBe(unsupported);

    const malformedRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-acp-index-shape-"));
    temporaryDirectories.push(malformedRoot);
    const malformedPath = path.join(malformedRoot, "acp-sessions.json");
    const malformed = `${JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "incomplete" }]
    })}\n`;
    await writeFile(malformedPath, malformed, "utf8");
    await expect(new SigmaAcpSessionRegistry(options).index(malformedRoot))
      .rejects.toMatchObject({
        code: "persisted_state_invalid",
        path: malformedPath
      });
    expect(await readFile(malformedPath, "utf8")).toBe(malformed);
  });

  it("coalesces concurrent cold-session attachments into one runtime resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-acp-attach-"));
    temporaryDirectories.push(root);
    const runtime = new FakeRuntime();
    const session = await runtime.createSession({ workspacePath: root, mode: "change" });
    let resumeStarted!: () => void;
    let allowResume!: () => void;
    let resumeStarts = 0;
    const started = new Promise<void>((resolve) => { resumeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { allowResume = resolve; });
    runtime.resumeSettlement = {
      started() {
        resumeStarts += 1;
        resumeStarted();
      },
      wait: gate
    };
    const handle = {
      runtime,
      workspace: root,
      storeRootDir: path.join(root, "state"),
      close: async () => undefined
    };
    const registry = new SigmaAcpSessionRegistry({
      agentVersion: "test",
      runtimeFactory: async () => handle,
      modelCatalog: async () => ({ currentModelId: "test/model", options: [] })
    });
    const now = new Date().toISOString();
    const resolved = {
      handle,
      record: {
        sessionId: session.sessionId,
        runtimeSessionId: session.sessionId,
        cwd: root,
        modelId: "test/model",
        mode: "change" as const,
        createdAt: now,
        updatedAt: now,
        started: true,
        lastSeq: 1
      }
    };

    const first = registry.ensureAttached(resolved);
    await started;
    const second = registry.ensureAttached(resolved);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resumeStarts).toBe(1);
    allowResume();
    await Promise.all([first, second]);
    expect(runtime.commands.filter((command) => command.type === "resume")).toHaveLength(1);
  });

  it("speaks NDJSON JSON-RPC and maps streaming, plans, tools, approvals, cancellation, load and resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-acp-contract-"));
    temporaryDirectories.push(root);
    const runtime = new FakeRuntime();
    const nativeSession = await runtime.createSession({ workspacePath: root, mode: "change" });
    runtime.seedHistory(nativeSession.sessionId, "Existing native Sigma session");
    const coldSession = await runtime.createSession({ workspacePath: root, mode: "change" });
    runtime.requireResumeBeforeCancel(coldSession.sessionId);
    const updates: acp.SessionNotification[] = [];
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    let permissionOptionId = "allow";
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();
    const diagnostics = new PassThrough();
    let protocolOutput = "";
    let diagnosticOutput = "";
    agentToClient.on("data", (chunk: Buffer) => {
      protocolOutput += chunk.toString("utf8");
    });
    diagnostics.on("data", (chunk: Buffer) => {
      diagnosticOutput += chunk.toString("utf8");
    });
    const serving = runAcpCommand([], {
      runtime,
      runtimeFactoryDeps: { stateRootDir: path.join(root, "state") },
      stdin: clientToAgent,
      stdout: agentToClient,
      stderr: diagnostics
    });
    const client = acp.client({ name: "sigma-acp-contract-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        const optionId = params._meta?.["sigma.permission.requiresExplicitDecision"] === true
          ? "keep"
          : permissionOptionId;
        return { outcome: { outcome: "selected", optionId } };
      });
    const clientConnection = client.connect(acp.ndJsonStream(
      Writable.toWeb(clientToAgent),
      Readable.toWeb(agentToClient)
    ));

    try {
      const initialized = await clientConnection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "contract-test", version: "1" }
      });
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
      expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
      expect(Object.hasOwn(initialized as object, "authMethods")).toBe(false);
      const health = await clientConnection.agent.request<SigmaHealthForTest, Record<string, never>>(
        "_sigma/health",
        {}
      );
      expect(health).toMatchObject({ ok: true, name: "Sigma", protocolVersion: 1 });
      const nativeList = await clientConnection.agent.request(acp.methods.agent.session.list, {
        cwd: root
      });
      expect(nativeList.sessions.map((session) => session.sessionId)).toContain(nativeSession.sessionId);
      const beforeColdCancel = runtime.commands.length;
      let coldCancelStarted!: () => void;
      const coldCancellation = new Promise<void>((resolve) => { coldCancelStarted = resolve; });
      runtime.cancelSettlement = { started: coldCancelStarted, wait: Promise.resolve() };
      const coldNotification = clientConnection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: coldSession.sessionId
      });
      await coldCancellation;
      await coldNotification;
      expect(runtime.commands.slice(beforeColdCancel)).toEqual([
        { type: "resume", sessionId: coldSession.sessionId },
        {
          type: "cancel",
          sessionId: coldSession.sessionId,
          reason: "Cancelled by ACP client."
        }
      ]);
      delete runtime.cancelSettlement;
      const beforeNativeReplay = updates.length;
      await clientConnection.agent.request(acp.methods.agent.session.load, {
        sessionId: nativeSession.sessionId,
        cwd: root,
        mcpServers: []
      });
      expect(updates.slice(beforeNativeReplay)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          _meta: expect.objectContaining({ isReplay: true }),
          update: expect.objectContaining({ sessionUpdate: "agent_message_chunk" })
        })
      ]));
      await clientConnection.agent.request(acp.methods.agent.session.close, {
        sessionId: nativeSession.sessionId
      });
      expect(runtime.releasedSessions).toContain(nativeSession.sessionId);
      await clientConnection.agent.request(acp.methods.agent.session.resume, {
        sessionId: nativeSession.sessionId,
        cwd: root,
        mcpServers: []
      });
      expect(runtime.commands).toContainEqual({
        type: "resume",
        sessionId: nativeSession.sessionId
      });

      const created = await clientConnection.agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: []
      });
      expect(created.sessionId).toMatch(/^sigma-/u);
      expect(created.configOptions?.[0]?.category).toBe("model");
      expect(created.configOptions?.[0]?.options).toEqual(expect.arrayContaining([
        expect.objectContaining({
          value: "openai-codex/gpt-5.6-terra",
          description: "openai-codex · subscription"
        })
      ]));
      expect(created.configOptions?.[1]).toMatchObject({
        id: "sigma.reasoning_effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "none", name: "None" },
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra High" },
          { value: "max", name: "Max" }
        ]
      });
      const changedReasoning = await clientConnection.agent.request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId: created.sessionId,
          configId: "sigma.reasoning_effort",
          value: "high"
        }
      );
      expect(changedReasoning.configOptions[1]).toMatchObject({ currentValue: "high" });
      runtime.seedCheckpointRecovery(runtime.latestSessionId(), "checkpoint-1");
      const modelSwitchSession = await clientConnection.agent.request(
        acp.methods.agent.session.new,
        { cwd: root, mcpServers: [] }
      );
      const changedModel = await clientConnection.agent.request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId: modelSwitchSession.sessionId,
          configId: "sigma.model",
          value: "glm/glm-5.2"
        }
      );
      expect(changedModel.configOptions[0]).toMatchObject({ currentValue: "glm/glm-5.2" });
      expect(changedModel.configOptions[1]).toMatchObject({
        id: "sigma.reasoning_effort",
        currentValue: "medium",
        options: [
          { value: "none", name: "None" },
          { value: "minimal", name: "Minimal" },
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" }
        ]
      });
      expect(changedModel.configOptions).toHaveLength(2);

      const prompt = await clientConnection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Update README" }]
      });
      expect(prompt.stopReason).toBe("end_turn");
      expect(permissionRequests).toHaveLength(2);
      expect(permissionRequests[0]).toMatchObject({
        options: [
          { optionId: "keep", name: "Keep current changes", kind: "allow_once" },
          {
            optionId: "restore",
            name: "Restore pre-interruption state",
            kind: "reject_once"
          }
        ],
        _meta: {
          "sigma.permission.requiresExplicitDecision": true,
          "sigma.checkpoint.id": "checkpoint-1"
        }
      });
      expect(runtime.commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "checkpoint_recovery",
          checkpointId: "checkpoint-1",
          decision: "keep"
        }),
        expect.objectContaining({ type: "submit", text: "Update README" }),
        expect.objectContaining({ type: "approve", decision: "allow" })
      ]));
      const updateKinds = updates.map((notification) => notification.update.sessionUpdate);
      expect(updateKinds).toEqual(expect.arrayContaining([
        "agent_message_chunk",
        "agent_thought_chunk",
        "plan",
        "tool_call",
        "tool_call_update"
      ]));
      expect(updates.some((notification) =>
        notification.update.sessionUpdate === "tool_call_update"
        && notification.update.status === "completed"
      )).toBe(true);

      const changedReasoningAfterPrompt = await clientConnection.agent.request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId: created.sessionId,
          configId: "sigma.reasoning_effort",
          value: "max"
        }
      );
      expect(changedReasoningAfterPrompt.configOptions[1]).toMatchObject({
        currentValue: "max"
      });
      const secondPrompt = await clientConnection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Check the result" }]
      });
      expect(secondPrompt.stopReason).toBe("end_turn");
      expect(runtime.commands).toContainEqual(expect.objectContaining({
        type: "follow_up",
        text: "Check the result"
      }));
      await clientConnection.agent.request<object, SigmaTextCommandForTest>(
        "_sigma/steer",
        { sessionId: created.sessionId, text: "Focus on the final diff" }
      );
      expect(runtime.commands).toContainEqual(expect.objectContaining({
        type: "steer",
        text: "Focus on the final diff"
      }));

      const beforeReplay = updates.length;
      await clientConnection.agent.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: root,
        mcpServers: []
      });
      expect(updates.slice(beforeReplay).some((notification) => notification._meta?.isReplay === true))
        .toBe(true);

      permissionOptionId = "deny";
      const denied = await clientConnection.agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: []
      });
      const deniedPrompt = await clientConnection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: denied.sessionId,
        prompt: [{ type: "text", text: "Try a denied tool" }]
      });
      expect(deniedPrompt.stopReason).toBe("cancelled");
      expect(runtime.commands).toContainEqual(expect.objectContaining({
        type: "approve",
        decision: "deny"
      }));
      permissionOptionId = "allow";

      const cancellable = await clientConnection.agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: []
      });
      const pendingPrompt = clientConnection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: cancellable.sessionId,
        prompt: [{ type: "text", text: "wait for cancellation" }]
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let cancelStarted!: () => void;
      let releaseCancel!: () => void;
      const cancelStartedPromise = new Promise<void>((resolve) => { cancelStarted = resolve; });
      const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
      runtime.cancelSettlement = { started: cancelStarted, wait: cancelGate };
      const notification = clientConnection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: cancellable.sessionId
      });
      await cancelStartedPromise;
      let promptSettled = false;
      void pendingPrompt.then(() => { promptSettled = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(promptSettled).toBe(false);
      const promptAfterCancel = clientConnection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: cancellable.sessionId,
          prompt: [{ type: "text", text: "continue after cancellation" }]
        }
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(runtime.commands).not.toContainEqual(expect.objectContaining({
        type: "steer",
        text: "continue after cancellation"
      }));
      releaseCancel();
      await notification;
      expect((await pendingPrompt).stopReason).toBe("cancelled");
      expect((await promptAfterCancel).stopReason).toBe("end_turn");
      expect(runtime.commands).toContainEqual(expect.objectContaining({
        type: "follow_up",
        text: "continue after cancellation"
      }));
      delete runtime.cancelSettlement;

      const failing = await clientConnection.agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: []
      });
      await expect(clientConnection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: failing.sessionId,
        prompt: [{ type: "text", text: "fail provider" }]
      })).rejects.toMatchObject({
        code: -32001,
        message: "The model provider is temporarily unavailable.",
        data: {
          "sigma.outcome": "recoverable_failure",
          "sigma.code": "server"
        }
      });

      await clientConnection.agent.request(acp.methods.agent.session.close, {
        sessionId: created.sessionId
      });
      await clientConnection.agent.request(acp.methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd: root,
        mcpServers: []
      });
      expect(runtime.commands).toContainEqual(expect.objectContaining({
        type: "resume"
      }));
      const listed = await clientConnection.agent.request(acp.methods.agent.session.list, {
        cwd: root
      });
      expect(listed.sessions.map((session) => session.sessionId)).toContain(created.sessionId);
      expect(listed.sessions.filter((session) => session.sessionId === nativeSession.sessionId))
        .toHaveLength(1);
    } finally {
      clientConnection.close();
      clientToAgent.end();
      await Promise.allSettled([clientConnection.closed, serving]);
    }
    await expect(serving).resolves.toBe(0);
    expect(diagnosticOutput).toBe("");
    const protocolLines = protocolOutput.trim().split(/\r?\n/u);
    expect(protocolLines.length).toBeGreaterThan(0);
    for (const line of protocolLines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

interface SigmaTextCommandForTest {
  sessionId: string;
  text: string;
}

interface SigmaHealthForTest {
  ok: boolean;
  name: string;
  protocolVersion: number;
  version: string;
}
