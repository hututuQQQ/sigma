import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION
} from "../packages/agent-protocol/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import { auditDurableChildren, createChildAgentFactory, createRuntime as createBaseRuntime, restoreStoredSession } from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { AgentSupervisor } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";
import { registerContentValidator, validationTurn } from "./helpers/content-validator.js";
import { typedCompletion } from "./helpers/typed-evidence.js";

const createRuntime = (options: Parameters<typeof createBaseRuntime>[0]) => createBaseRuntime({
  ...options,
  reviewer: createApprovingReviewer()
});

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ScriptedResponse = ModelResponse | ((request: ModelRequest) => ModelResponse);

function completion(summary: string): (request: ModelRequest) => ModelResponse {
  return (request) => typedCompletion(request, {
    id: `complete-${summary}`,
    summary,
    criterion: "Requested work is complete."
  });
}

class ScriptedGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "scripted";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  readonly requests: ModelRequest[] = [];
  readonly firstStarted: Promise<void>;
  private startFirst!: () => void;
  private releaseFirst!: () => void;
  private readonly firstGate: Promise<void>;

  constructor(private readonly responses: ScriptedResponse[], private readonly blockFirst = false) {
    this.firstStarted = new Promise((resolve) => { this.startFirst = resolve; });
    this.firstGate = new Promise((resolve) => { this.releaseFirst = resolve; });
  }

  release(): void { this.releaseFirst(); }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Tests consume the streaming interface.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      this.startFirst();
      if (this.blockFirst) await this.firstGate;
    }
    const scripted = this.responses.shift();
    if (!scripted) throw new Error("No scripted response remains.");
    yield { type: "done", response: typeof scripted === "function" ? scripted(request) : scripted };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

class FailingFirstGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "failing-first";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  readonly firstStarted: Promise<void>;
  readonly firstFailed: Promise<void>;
  private startFirst!: () => void;
  private releaseFirst!: () => void;
  private observeFailure!: () => void;
  private readonly firstGate: Promise<void>;
  private requests = 0;

  constructor() {
    this.firstStarted = new Promise((resolve) => { this.startFirst = resolve; });
    this.firstFailed = new Promise((resolve) => { this.observeFailure = resolve; });
    this.firstGate = new Promise((resolve) => { this.releaseFirst = resolve; });
  }

  failFirst(): void { this.releaseFirst(); }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Tests consume the streaming interface.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests += 1;
    if (this.requests === 1) {
      this.startFirst();
      await this.firstGate;
      this.observeFailure();
      throw Object.assign(new Error("old turn failed"), { code: "old_turn_failure" });
    }
    const response = this.requests === 2
      ? {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "read-after-steer", name: "read", arguments: { path: "seed.txt" } }]
        },
        finishReason: "tool_calls" as const
      }
      : completion("steering survived stale failure")(request);
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

async function storedEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("runtime queues and non-blocking instruction steering", () => {
  it("suspends a conversational natural stop after one model turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-natural-stop-"));
    const gateway = new ScriptedGateway([{
      message: { role: "assistant", content: "Hello. What would you like me to work on?" },
      finishReason: "stop"
    }]);
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const runtime = createRuntime({
      gateway, store, storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "hi" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toEqual({
      kind: "needs_input",
      requestId: "model-response-1",
      message: "Hello. What would you like me to work on?"
    });
    expect(gateway.requests).toHaveLength(1);
    const events = await storedEvents(store, session.sessionId);
    expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.suspended")).toHaveLength(1);
  });

  it("supports an explicit typed request for user input", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-request-input-"));
    const gateway = new ScriptedGateway([{
      message: {
        role: "assistant", content: "",
        toolCalls: [{ id: "need-target", name: "request_user_input", arguments: { message: "Which target should I change?" } }]
      },
      finishReason: "tool_calls"
    }]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") }),
      storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "change it" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toEqual({
      kind: "needs_input", requestId: "need-target", message: "Which target should I change?"
    });
  });

  it("bounds completion repair when a model keeps returning plain text", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-bounded-completion-repair-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "read-progress", name: "read", arguments: { path: "seed.txt" } }] },
        finishReason: "tool_calls"
      },
      { message: { role: "assistant", content: "I am done." }, finishReason: "stop" },
      { message: { role: "assistant", content: "I am still done." }, finishReason: "stop" }
    ]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") }),
      storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 30_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "inspect seed" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input", message: "I am still done."
    });
    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[2].messages.at(-1)).toMatchObject({ role: "developer" });
  }, 30_000);

  it("rejects a reused tool call id across model turns instead of replaying an idempotent receipt", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-call-id-ledger-"));
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "same-id", name: "write", arguments: { path: "a.txt", content: "A" } }] },
        finishReason: "tool_calls"
      },
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "same-id", name: "write", arguments: { path: "b.txt", content: "B" } }] },
        finishReason: "tool_calls"
      }
    ]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") }),
      storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write two files" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure", code: "protocol_error"
    });
    await expect(readFile(path.join(workspace, "a.txt"), "utf8")).resolves.toBe("A");
    await expect(readFile(path.join(workspace, "b.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops three consecutive identical tool batches without executing the third", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repeated-batch-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const gateway = new ScriptedGateway([1, 2, 3].map((index) => ({
      message: { role: "assistant", content: "", toolCalls: [{ id: `repeat-${index}`, name: "read", arguments: { path: "seed.txt" } }] },
      finishReason: "tool_calls" as const
    })));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const runtime = createRuntime({
      gateway, store, storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "inspect without looping" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure", code: "agent_no_progress"
    });
    const events = await storedEvents(store, session.sessionId);
    const receipts = events.filter((event) => event.type === "tool.completed");
    expect(receipts).toHaveLength(2);
    expect(receipts.every((event) => (event.payload as { outcome?: unknown }).outcome
      && (event.payload as { outcome: { status?: unknown } }).outcome.status === "succeeded")).toBe(true);
  });

  it("removes aborted outcome waiters", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-outcome-waiter-"));
    const runtime = createRuntime({
      gateway: new ScriptedGateway([]),
      store: new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") }),
      storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    const controller = new AbortController();
    const waiting = runtime.waitForOutcome(session.sessionId, controller.signal);
    controller.abort(new Error("stop waiting"));
    await expect(waiting).rejects.toThrow("stop waiting");
    const sessions = (runtime as unknown as { sessions: Map<string, { outcomeWaiters: unknown[] }> }).sessions;
    expect(sessions.get(session.sessionId)?.outcomeWaiters).toHaveLength(0);
    await runtime.command({ type: "cancel", sessionId: session.sessionId, reason: "test cleanup" });
  });

  it("reports deletion of a pre-existing untracked file in workspace delta", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-delta-untracked-delete-"));
    execFileSync("git", ["-C", workspace, "init"], { windowsHide: true });
    execFileSync("git", ["-C", workspace, "config", "user.email", "sigma-tests@example.invalid"], { windowsHide: true });
    execFileSync("git", ["-C", workspace, "config", "user.name", "Sigma Tests"], { windowsHide: true });
    await writeFile(path.join(workspace, "tracked.txt"), "tracked", "utf8");
    execFileSync("git", ["-C", workspace, "add", "tracked.txt"], { windowsHide: true });
    execFileSync("git", ["-C", workspace, "commit", "-m", "initial"], { windowsHide: true });
    await writeFile(path.join(workspace, "victim.txt"), "remove me", "utf8");
    const tools = registerContentValidator(registerBuiltinTools(new EffectToolRegistry()));
    tools.register({
      descriptor: {
        name: "remove_fixture", description: "Remove the fixture file.", inputSchema: { type: "object" },
        possibleEffects: ["filesystem.write"], executionMode: "exclusive", resourceKeys: ["workspace:write"],
        approval: "auto", idempotent: false, timeoutMs: 5_000
      },
      async execute(request, context): Promise<ToolReceipt> {
        const startedAt = new Date().toISOString();
        await rm(path.join(context.workspacePath, "victim.txt"));
        return {
          callId: request.callId, ok: true, output: "removed", observedEffects: ["filesystem.write"],
          artifacts: [], diagnostics: [], startedAt, completedAt: new Date().toISOString()
        };
      }
    });
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "remove-victim", name: "remove_fixture", arguments: {} }] },
        finishReason: "tool_calls"
      },
      validationTurn("validate-removal", [{ path: "victim.txt", absent: true }]),
      completion("removed victim")
    ]);
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const runtime = createRuntime({
      gateway, store, storeRootDir: path.join(workspace, ".agent"), tools, permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "remove victim" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const deltaEvidence = (await storedEvents(store, session.sessionId)).find((event) =>
      event.type === "evidence.recorded"
      && (event.payload as { kind?: string }).kind === "workspace_delta");
    expect(deltaEvidence?.payload).toMatchObject({
      kind: "workspace_delta",
      data: { delta: { deleted: ["victim.txt"] } }
    });
  });

  it("restores joined child completion evidence from the durable outcome", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-child-evidence-recovery-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const storeRootDir = path.join(workspace, ".agent");
    const firstStore = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const first = createRuntime({
      gateway: new ScriptedGateway([
        {
          message: { role: "assistant", content: "", toolCalls: [{ id: "read-for-evidence", name: "read", arguments: { path: "seed.txt" } }] },
          finishReason: "tool_calls"
        },
        completion("joined evidence")
      ]),
      store: firstStore,
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 10_000,
      joinChildren: async () => ({ evidence: [{ childId: "durable-child", status: "completed" }], failures: [] })
    });
    const session = await first.createSession({ workspacePath: workspace, mode: "analyze" });
    await first.command({ type: "submit", sessionId: session.sessionId, text: "inspect with child evidence" });
    await expect(first.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      evidence: expect.arrayContaining([expect.objectContaining({
        kind: "child_outcome",
        status: "passed",
        data: expect.objectContaining({ childId: "durable-child", outcome: "completed" })
      })])
    });

    const resumed = createRuntime({
      gateway: new ScriptedGateway([]),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    await resumed.command({ type: "resume", sessionId: session.sessionId });
    await expect(resumed.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      evidence: expect.arrayContaining([expect.objectContaining({
        kind: "child_outcome",
        status: "passed",
        data: expect.objectContaining({ childId: "durable-child", outcome: "completed" })
      })])
    });
  });

  it("rehydrates durable follow-ups in FIFO order and removes delivered entries", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-follow-up-recovery-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const sessionId = "follow-up-session";
    const runId = "follow-up-run";
    let seq = 0;
    const append = async (type: AgentEventEnvelope["type"], payload: AgentEventEnvelope["payload"]): Promise<void> => {
      const event: AgentEventEnvelope = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        seq: seq + 1,
        eventId: `event-${seq + 1}`,
        sessionId,
        runId,
        occurredAt: new Date(Date.now() + seq).toISOString(),
        type,
        authority: type === "user.message" || type === "user.follow_up" ? "user" : "runtime",
        payload
      };
      await store.append(event, seq);
      seq += 1;
    };
    await append("session.created", { workspacePath: workspace, mode: "change" });
    await append("run.started", { mode: "change", deadlineAt: new Date(Date.now() + 30_000).toISOString() });
    await append("user.message", { text: "initial" });
    await append("user.follow_up", { text: "first", queueId: "queue-1", status: "queued" });
    await append("user.follow_up", { text: "second", queueId: "queue-2", status: "queued" });
    await append("user.follow_up", { text: "first", queueId: "queue-1", status: "delivered" });
    await append("diagnostic", {
      kind: "nested_instructions_loaded",
      items: [{
        id: "project:nested", authority: "project", provenance: "nested/AGENTS.md", content: "nested rule",
        tokenCount: 3, priority: 9_000
      }]
    });
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId, seq, createdAt: new Date().toISOString(),
      state: { schemaVersion: 2, sessionId, messages: "invalid" }
    });

    const restored = await restoreStoredSession(store, sessionId, 30_000);
    expect(restored.followUps).toEqual([{ id: "queue-2", text: "second" }]);
    expect(restored.contextItems).toContainEqual(expect.objectContaining({ id: "project:nested", content: "nested rule" }));
    expect(restored.state.messages.filter((message) => message.role === "user").map((message) => message.content))
      .toEqual(["initial", "first"]);
  });

  it("preserves assistant reasoning content when restoring a snapshot", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-reasoning-recovery-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const sessionId = "reasoning-session";
    const runId = "reasoning-run";
    const startedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: 1,
      eventId: "reasoning-created",
      sessionId,
      runId,
      occurredAt: startedAt,
      type: "session.created",
      authority: "runtime",
      payload: { workspacePath: workspace, mode: "change" }
    }, 0);
    const snapshotState = {
      ...createKernelState({ sessionId, runId, mode: "change", startedAt, deadlineAt }),
      phase: "ready_model" as const,
      revision: 1,
      lastSeq: 1,
      messages: [{ role: "assistant" as const, content: "", reasoningContent: "durable reasoning" }]
    };
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: snapshotState
    });

    const restored = await restoreStoredSession(store, sessionId, 30_000);
    expect(restored.state.messages).toEqual([
      { role: "assistant", content: "", reasoningContent: "durable reasoning" }
    ]);
  });

  it.each([
    ["change", "analyze", "without a snapshot", false],
    ["change", "analyze", "from an older snapshot", true],
    ["analyze", "change", "without a snapshot", false],
    ["analyze", "change", "from an older snapshot", true]
  ] as const)("restores %s -> %s run mode %s", async (initialMode, currentMode, _scenario, withSnapshot) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-mode-recovery-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const sessionId = `mode-${initialMode}-${currentMode}-${withSnapshot}`;
    const firstRunId = "first-run";
    const currentRunId = "current-run";
    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    let seq = 0;
    const append = async (
      runId: string,
      type: AgentEventEnvelope["type"],
      payload: AgentEventEnvelope["payload"]
    ): Promise<void> => {
      const stored: AgentEventEnvelope = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        seq: seq + 1,
        eventId: `mode-event-${seq + 1}`,
        sessionId,
        runId,
        occurredAt: new Date(Date.now() + seq).toISOString(),
        type,
        authority: type === "user.message" ? "user" : "runtime",
        payload
      };
      await store.append(stored, seq);
      seq += 1;
    };
    await append(firstRunId, "session.created", { workspacePath: workspace, mode: initialMode });
    await append(firstRunId, "run.started", { mode: initialMode, deadlineAt });
    await append(firstRunId, "user.message", { text: "first run" });
    await append(firstRunId, "model.started", { turnId: 1, effectRevision: 3 });
    await append(firstRunId, "model.completed", {
      turnId: 1,
      effectRevision: 3,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "complete-first", name: "complete_task", arguments: {} }]
      },
      toolCalls: [{ id: "complete-first", name: "complete_task", arguments: {} }],
      finishReason: "tool_calls"
    });
    await append(firstRunId, "tool.completed", {
      turnId: 1,
      effectRevision: 3,
      callId: "complete-first",
      ok: true,
      output: JSON.stringify({ summary: "first done", criteria: [] }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: "start",
      completedAt: "end"
    });
    await append(firstRunId, "run.completed", { message: "first done", outcomeRevision: seq });
    if (withSnapshot) {
      const firstRunState = {
        ...createKernelState({
          sessionId,
          runId: firstRunId,
          mode: initialMode,
          startedAt: new Date().toISOString(),
          deadlineAt
        }),
        phase: "terminal" as const,
        revision: seq,
        lastSeq: seq,
        messages: [{ role: "user" as const, content: "first run" }],
        outcome: { kind: "completed" as const, message: "first done", evidence: [] }
      };
      await store.writeSnapshot({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        storeLayoutVersion: STORE_LAYOUT_VERSION,
        sessionId,
        seq,
        createdAt: new Date().toISOString(),
        state: firstRunState
      });
    }
    await append(currentRunId, "run.started", { mode: currentMode, deadlineAt });
    await append(currentRunId, "user.message", { text: "current run" });

    const restored = await restoreStoredSession(store, sessionId, 30_000);
    expect(restored.mode).toBe(currentMode);
    expect(restored.state).toMatchObject({ runId: currentRunId, mode: currentMode, phase: "ready_model" });
  });

  it("enforces child write scope before a shared-workspace mutation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-write-scope-"));
    await mkdir(path.join(workspace, "allowed"), { recursive: true });
    await mkdir(path.join(workspace, "other"), { recursive: true });
    await symlink(
      path.join(workspace, "other"), path.join(workspace, "allowed", "link"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "outside", name: "write", arguments: { path: "outside.txt", content: "bad" } }] },
        finishReason: "tool_calls"
      },
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "linked", name: "write", arguments: { path: "allowed/link/escaped.txt", content: "bad" } }] },
        finishReason: "tool_calls"
      },
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "inside", name: "write", arguments: { path: "allowed/inside.txt", content: "good" } }] },
        finishReason: "tool_calls"
      },
      validationTurn("validate-scoped-write", [{ path: "allowed/inside.txt", expected: "good" }]),
      completion("scoped write completed")
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({
      workspacePath: workspace, mode: "change", writeScope: ["allowed"], strictWriteScope: true
    });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write only inside allowed" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readFile(path.join(workspace, "outside.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(workspace, "other", "escaped.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(workspace, "allowed", "inside.txt"), "utf8")).resolves.toBe("good");
    const events = await storedEvents(store, session.sessionId);
    expect(events.some((event) => event.type === "tool.failed"
      && (event.payload as { diagnostics?: string[] }).diagnostics?.includes("write_scope_denied"))).toBe(true);
  });

  it("blocks completion for an interrupted or unintegrated durable child", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-durable-child-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const parentSessionId = "parent-session";
    let seq = 0;
    const append = async (type: "child.spawned" | "child.completed" | "child.message", detail: Record<string, unknown>): Promise<void> => {
      const event = {
        schemaVersion: EVENT_SCHEMA_VERSION, seq: seq + 1, eventId: `child-event-${seq + 1}`, parentSessionId,
        sessionId: parentSessionId, runId: "parent-run", occurredAt: new Date(Date.now() + seq).toISOString(),
        type, authority: "runtime" as const, payload: { childId: "child-1", payload: detail }
      };
      await store.append(event, seq);
      seq += 1;
    };
    await append("child.spawned", { detached: false });
    await expect(auditDurableChildren(store, parentSessionId)).resolves.toMatchObject({
      failures: [expect.stringContaining("interrupted")]
    });
    await append("child.completed", {
      status: "completed",
      isolation: { kind: "git_worktree", cleanup: "retained", worktreePath: "worktree" }
    });
    await expect(auditDurableChildren(store, parentSessionId)).resolves.toMatchObject({
      failures: [expect.stringContaining("unintegrated")]
    });
    await append("child.message", { kind: "integrated" });
    await expect(auditDurableChildren(store, parentSessionId)).resolves.toMatchObject({ failures: [] });
  });

  it("preserves 100 steering messages and rejects the superseded model turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-steering-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "stale-write", name: "write", arguments: { path: "stale.txt", content: "stale" } }] },
        finishReason: "tool_calls"
      },
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "read-seed", name: "read", arguments: { path: "seed.txt" } }] },
        finishReason: "tool_calls"
      },
      completion("steering preserved")
    ], true);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto", runDeadlineMs: 30_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "read the seed", mode: "analyze" });
    await gateway.firstStarted;
    const messages = Array.from({ length: 100 }, (_, index) => `steer-${index}`);
    await Promise.all(messages.map(async (text) => await runtime.command({ type: "steer", sessionId: session.sessionId, text })));
    gateway.release();
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const events = await storedEvents(store, session.sessionId);
    const steering = events
      .filter((event) => event.type === "user.steer")
      .map((event) => (event.payload as { text: string }).text);
    expect(steering).toEqual(messages);
    await expect(readFile(path.join(workspace, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(gateway.requests.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("does not let an old model failure overtake durable steering", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-steering-failure-race-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const append = store.append.bind(store);
    let steeringAppendEntered!: () => void;
    let releaseSteeringAppend!: () => void;
    const appendEntered = new Promise<void>((resolve) => { steeringAppendEntered = resolve; });
    const appendGate = new Promise<void>((resolve) => { releaseSteeringAppend = resolve; });
    store.append = async (event, expectedSeq) => {
      const result = await append(event, expectedSeq);
      if (event.type !== "user.steer") return result;
      steeringAppendEntered();
      await appendGate;
      return result;
    };
    const gateway = new FailingFirstGateway();
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "initial instruction", mode: "analyze" });
    await gateway.firstStarted;
    const steering = runtime.command({ type: "steer", sessionId: session.sessionId, text: "replacement instruction" });
    await appendEntered;
    gateway.failFirst();
    await gateway.firstFailed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSteeringAppend();
    await steering;

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed", message: "steering survived stale failure"
    });
    const events = await storedEvents(store, session.sessionId);
    expect(events.some((event) => event.type === "model.failed"
      && (event.payload as { code?: string }).code === "old_turn_failure")).toBe(false);
    expect(events.some((event) => event.type === "run.failed"
      && (event.payload as { code?: string }).code === "old_turn_failure")).toBe(false);
  });

  it("does not let a stale successful tool receipt complete over newer steering", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-steering-tool-race-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const append = store.append.bind(store);
    let steeringAppendEntered!: () => void;
    let releaseSteeringAppend!: () => void;
    const appendEntered = new Promise<void>((resolve) => { steeringAppendEntered = resolve; });
    const appendGate = new Promise<void>((resolve) => { releaseSteeringAppend = resolve; });
    store.append = async (event, expectedSeq) => {
      const result = await append(event, expectedSeq);
      if (event.type !== "user.steer") return result;
      steeringAppendEntered();
      await appendGate;
      return result;
    };
    let slowStarted!: () => void;
    let releaseSlow!: () => void;
    const started = new Promise<void>((resolve) => { slowStarted = resolve; });
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const tools = registerBuiltinTools(new EffectToolRegistry());
    tools.register({
      descriptor: {
        name: "slow_complete",
        description: "Returns a delayed completion proposal for steering race coverage.",
        inputSchema: { type: "object" },
        possibleEffects: [],
        executionMode: "sequential",
        resourceKeys: [],
        approval: "auto",
        idempotent: false,
        timeoutMs: 10_000
      },
      async execute(request): Promise<ToolReceipt> {
        slowStarted();
        await slowGate;
        const now = new Date().toISOString();
        return {
          callId: request.callId,
          ok: true,
          output: JSON.stringify({ summary: "obsolete completion" }),
          observedEffects: ["outcome.propose"],
          artifacts: [], diagnostics: [], startedAt: now, completedAt: now
        };
      }
    });
    const gateway = new ScriptedGateway([
      {
        message: {
          role: "assistant", content: "",
          toolCalls: [{ id: "old-complete", name: "slow_complete", arguments: {} }]
        },
        finishReason: "tool_calls"
      },
      {
        message: {
          role: "assistant", content: "",
          toolCalls: [{ id: "corrected-read", name: "read", arguments: { path: "seed.txt" } }]
        },
        finishReason: "tool_calls"
      },
      completion("new steering completed")
    ]);
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools, permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "start old completion" });
    await started;
    const steering = runtime.command({
      type: "steer", sessionId: session.sessionId, text: "Use the new acceptance criteria."
    });
    await appendEntered;
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSteeringAppend();
    await steering;

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed", message: "new steering completed"
    });
    const events = await storedEvents(store, session.sessionId);
    expect(events.some((event) => event.type === "tool.completed"
      && (event.payload as { callId?: string }).callId === "old-complete")).toBe(false);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "run.completed")?.payload).toMatchObject({
      message: "new steering completed"
    });
  });

  it("does not commit an old outcome after steering wins a delayed child join", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-steering-outcome-race-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const gateway = new ScriptedGateway([
      {
        message: {
          role: "assistant", content: "",
          toolCalls: [{ id: "old-read", name: "read", arguments: { path: "seed.txt" } }]
        },
        finishReason: "tool_calls"
      },
      completion("obsolete joined outcome"),
      {
        message: {
          role: "assistant", content: "",
          toolCalls: [{ id: "new-read", name: "read", arguments: { path: "seed.txt" } }]
        },
        finishReason: "tool_calls"
      },
      completion("steering won outcome race")
    ]);
    let joinStarted!: () => void;
    let releaseJoin!: () => void;
    const firstJoin = new Promise<void>((resolve) => { joinStarted = resolve; });
    const joinGate = new Promise<void>((resolve) => { releaseJoin = resolve; });
    let joins = 0;
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 10_000,
      joinChildren: async () => {
        joins += 1;
        if (joins === 1) {
          joinStarted();
          await joinGate;
        }
        return { failures: [], evidence: [] };
      }
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "complete old outcome" });
    await firstJoin;
    await runtime.command({
      type: "steer", sessionId: session.sessionId, text: "Replace the acceptance criteria before commit."
    });
    releaseJoin();

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed", message: "steering won outcome race"
    });
    const events = await storedEvents(store, session.sessionId);
    const completions = events.filter((event) => event.type === "run.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0].payload).toMatchObject({ message: "steering won outcome race" });
  });

  it("supersedes a pending approval without implicitly approving or deadlocking", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-approval-steer-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed", "utf8");
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "stale-approved-write", name: "write", arguments: { path: "stale.txt", content: "stale" } }] },
        finishReason: "tool_calls"
      },
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "corrected-read", name: "read", arguments: { path: "seed.txt" } }] },
        finishReason: "tool_calls"
      },
      completion("approval steering completed")
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "ask", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const approval = (async () => {
      for await (const event of runtime.subscribe(session.sessionId)) {
        if (event.type === "tool.approval_requested") return;
      }
    })();
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "start then correct" });
    await approval;
    await runtime.command({ type: "steer", sessionId: session.sessionId, text: "Do not write; inspect seed instead." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readFile(path.join(workspace, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const events = await storedEvents(store, session.sessionId);
    expect(events.some((event) => event.type === "tool.approval_resolved"
      && (event.payload as { decision?: string }).decision === "superseded")).toBe(true);
  });

  it("shows simultaneous approvals and treats newly discovered instructions as diagnostics", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-approvals-"));
    await mkdir(path.join(workspace, "nested"));
    await writeFile(path.join(workspace, "nested", "AGENTS.md"), "Keep edits general and tested.", "utf8");
    const calls = [
      { id: "write-a", name: "write", arguments: { path: "nested/a.txt", content: "a" } },
      { id: "write-b", name: "write", arguments: { path: "nested/b.txt", content: "b" } }
    ];
    const replannedCalls = calls.map((call) => ({ ...call, id: `${call.id}-replanned` }));
    const gateway = new ScriptedGateway([
      { message: { role: "assistant", content: "", toolCalls: calls }, finishReason: "tool_calls" },
      { message: { role: "assistant", content: "", toolCalls: replannedCalls }, finishReason: "tool_calls" },
      validationTurn("validate-both-writes", [
        { path: "nested/a.txt", expected: "a" },
        { path: "nested/b.txt", expected: "b" }
      ]),
      completion("both writes completed")
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      permissionMode: "ask", runDeadlineMs: 10_000, maxParallelTools: 4
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const approvalIds: string[] = [];
    const approvalsReady = (async () => {
      for await (const event of runtime.subscribe(session.sessionId)) {
        if (event.type !== "tool.approval_requested") continue;
        approvalIds.push((event.payload as { requestId: string }).requestId);
        if (approvalIds.length === 2) return;
      }
    })();
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write both files" });
    await expect(Promise.race([
      approvalsReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Approvals were not exposed.")), 2_000))
    ])).resolves.toBeUndefined();
    expect(approvalIds.sort()).toEqual(["write-a-replanned", "write-b-replanned"]);
    for (const requestId of approvalIds) {
      await runtime.command({ type: "approve", sessionId: session.sessionId, requestId, decision: "allow" });
    }
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readFile(path.join(workspace, "nested", "a.txt"), "utf8")).resolves.toBe("a");
    await expect(readFile(path.join(workspace, "nested", "b.txt"), "utf8")).resolves.toBe("b");
    const events = await storedEvents(store, session.sessionId);
    expect(events.filter((event) => event.type === "tool.approval_requested")).toHaveLength(2);
    expect(events.some((event) => event.type === "diagnostic"
      && (event.payload as { kind?: string }).kind === "nested_instructions_loaded")).toBe(true);
    expect(events.filter((event) => event.type === "tool.failed"
      && (event.payload as { diagnostics?: string[] }).diagnostics?.includes("nested_instructions_require_replan"))).toHaveLength(2);
  });

  it("persists each parallel receipt without waiting for the rest of its batch", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-receipt-window-"));
    const calls = [
      { id: "fast-side-effect", name: "fast_side_effect", arguments: {} },
      { id: "approval-side-effect", name: "approval_side_effect", arguments: {} }
    ];
    const gateway = new ScriptedGateway([
      { message: { role: "assistant", content: "", toolCalls: calls }, finishReason: "tool_calls" },
      validationTurn("validate-parallel-writes", [
        { path: "fast.txt", expected: "fast_side_effect" },
        { path: "approved.txt", expected: "approval_side_effect" }
      ]),
      completion("receipts persisted")
    ]);
    const tools = registerContentValidator(registerBuiltinTools(new EffectToolRegistry()));
    const sideEffectTool = (name: string, approval: "auto" | "prompt", file: string) => ({
      descriptor: {
        name, description: name, inputSchema: { type: "object" as const }, possibleEffects: ["filesystem.write" as const],
        executionMode: "parallel" as const, resourceKeys: [file], approval, idempotent: false, timeoutMs: 5_000
      },
      async execute(request: { callId: string }, context: { workspacePath: string }) {
        const startedAt = new Date().toISOString();
        await writeFile(path.join(context.workspacePath, file), name, "utf8");
        return {
          callId: request.callId, ok: true, output: name, observedEffects: ["filesystem.write" as const],
          artifacts: [], diagnostics: [], startedAt, completedAt: new Date().toISOString()
        };
      }
    });
    tools.register(sideEffectTool("fast_side_effect", "auto", "fast.txt"));
    tools.register(sideEffectTool("approval_side_effect", "prompt", "approved.txt"));
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({ gateway, store, storeRootDir, tools, permissionMode: "ask", runDeadlineMs: 10_000 });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    let approvalSeen = false;
    let receiptSeen = false;
    const durableBoundary = (async () => {
      for await (const event of runtime.subscribe(session.sessionId)) {
        if (event.type === "tool.approval_requested") approvalSeen = true;
        if (event.type === "tool.completed" && (event.payload as { callId?: string }).callId === "fast-side-effect") receiptSeen = true;
        if (approvalSeen && receiptSeen) return;
      }
    })();
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "run both effects" });
    await expect(Promise.race([
      durableBoundary,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Fast receipt was not durable while approval waited.")), 2_000))
    ])).resolves.toBeUndefined();
    await expect(readFile(path.join(workspace, "fast.txt"), "utf8")).resolves.toBe("fast_side_effect");
    expect((await storedEvents(store, session.sessionId)).some((event) => event.type === "tool.completed"
      && (event.payload as { callId?: string }).callId === "fast-side-effect")).toBe(true);
    await runtime.command({ type: "approve", sessionId: session.sessionId, requestId: "approval-side-effect", decision: "allow" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
  });

  it("surfaces and resolves delegated child approvals instead of deadlocking", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-child-approval-"));
    const gateway = new ScriptedGateway([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "child-write", name: "write", arguments: { path: "child.txt", content: "child" } }]
        },
        finishReason: "tool_calls"
      },
      validationTurn("validate-child-write", [{ path: "child.txt", expected: "child" }]),
      completion("child completed")
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      permissionMode: "ask",
      runDeadlineMs: 10_000
    });
    const parent = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const messages: unknown[] = [];
    const supervisor = new AgentSupervisor(
      createChildAgentFactory(() => runtime),
      1,
      undefined,
      async (event) => { messages.push(event); }
    );
    const child = supervisor.spawn({
      parentId: parent.sessionId,
      instruction: "write child.txt",
      workspacePath: workspace,
      intent: "write",
      writeScope: ["child.txt"],
      delegatedEffects: ["filesystem.read", "filesystem.write", "process.spawn", "process.spawn.readonly", "validation"],
      metadata: { mode: "change" }
    });
    await expect(withDeadline(
      supervisor.join(child.id), 15_000, "Child approval deadlocked."
    )).resolves.toMatchObject({ status: "completed", result: { outcome: { kind: "completed" } } });
    await expect(readFile(path.join(workspace, "child.txt"), "utf8")).resolves.toBe("child");
    expect(messages.some((value) => JSON.stringify(value).includes("delegated_approval_resolved"))).toBe(true);
  }, 20_000);
});
