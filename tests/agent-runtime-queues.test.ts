import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { auditDurableChildren, createChildAgentFactory, createRuntime, restoreStoredSession } from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { AgentSupervisor } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

function completion(summary: string, evidenceCallIds: string[]): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `complete-${summary}`,
        name: "complete_task",
        arguments: {
          summary,
          criteria: [{ criterion: "Requested work is complete.", status: "met", evidenceCallIds, rationale: "" }]
        }
      }]
    },
    finishReason: "tool_calls"
  };
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

  constructor(private readonly responses: ModelResponse[], private readonly blockFirst = false) {
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
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response remains.");
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
  it("rehydrates durable follow-ups in FIFO order and removes delivered entries", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-follow-up-recovery-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const sessionId = "follow-up-session";
    const runId = "follow-up-run";
    let seq = 0;
    const append = async (type: AgentEventEnvelope["type"], payload: AgentEventEnvelope["payload"]): Promise<void> => {
      const event: AgentEventEnvelope = {
        schemaVersion: 2,
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
      schemaVersion: 2, sessionId, seq, createdAt: new Date().toISOString(),
      state: { schemaVersion: 2, sessionId, messages: "invalid" }
    });

    const restored = await restoreStoredSession(store, sessionId, 30_000);
    expect(restored.followUps).toEqual([{ id: "queue-2", text: "second" }]);
    expect(restored.contextItems).toContainEqual(expect.objectContaining({ id: "project:nested", content: "nested rule" }));
    expect(restored.state.messages.filter((message) => message.role === "user").map((message) => message.content))
      .toEqual(["initial", "first"]);
  });

  it("enforces child write scope before a shared-workspace mutation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-write-scope-"));
    const gateway = new ScriptedGateway([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "outside", name: "write", arguments: { path: "outside.txt", content: "bad" } }] },
        finishReason: "tool_calls"
      },
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "inside", name: "write", arguments: { path: "allowed/inside.txt", content: "good" } }] },
        finishReason: "tool_calls"
      },
      completion("scoped write completed", ["inside"])
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto", runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({
      workspacePath: workspace, mode: "change", writeScope: ["allowed"], strictWriteScope: true
    });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write only inside allowed" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readFile(path.join(workspace, "outside.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
        schemaVersion: 2 as const, seq: seq + 1, eventId: `child-event-${seq + 1}`, parentSessionId,
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
      completion("steering preserved", ["read-seed"])
    ], true);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto", runDeadlineMs: 10_000
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
      completion("approval steering completed", ["corrected-read"])
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
      completion("both writes completed", replannedCalls.map((call) => call.id))
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway, store, storeRootDir, tools: registerBuiltinTools(new EffectToolRegistry()),
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
      completion("receipts persisted", calls.map((call) => call.id))
    ]);
    const tools = registerBuiltinTools(new EffectToolRegistry());
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
      completion("child completed", ["child-write"])
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "ask",
      runDeadlineMs: 10_000
    });
    const messages: unknown[] = [];
    const supervisor = new AgentSupervisor(
      createChildAgentFactory(() => runtime),
      1,
      undefined,
      async (event) => { messages.push(event); }
    );
    const child = supervisor.spawn({
      parentId: "parent",
      instruction: "write child.txt",
      workspacePath: workspace,
      intent: "write",
      writeScope: ["child.txt"],
      delegatedEffects: ["filesystem.read", "filesystem.write", "process.spawn", "process.spawn.readonly", "validation"],
      metadata: { mode: "change" }
    });
    await expect(Promise.race([
      supervisor.join(child.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Child approval deadlocked.")), 3_000))
    ])).resolves.toMatchObject({ status: "completed", result: { outcome: { kind: "completed" } } });
    await expect(readFile(path.join(workspace, "child.txt"), "utf8")).resolves.toBe("child");
    expect(messages.some((value) => JSON.stringify(value).includes("delegated_approval_resolved"))).toBe(true);
  });
});
