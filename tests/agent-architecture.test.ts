import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
import { EVENT_SCHEMA_VERSION } from "../packages/agent-protocol/src/index.js";
import { createKernelState, evolve } from "../packages/agent-kernel/src/index.js";
import { lexicalScore, lexicalTokens, planContext } from "../packages/agent-context/src/index.js";
import { resolveWorkspacePath } from "../packages/agent-platform/src/index.js";
import { SegmentedJsonlStore, sessionDirectory } from "../packages/agent-store/src/index.js";
import { createRuntime as createBaseRuntime, sendSessionCommand } from "../packages/agent-runtime/src/testing.js";
import { repositoryListJsonLines } from "../packages/agent-runtime/src/repository-statistics-provider.js";
import { EffectToolRegistry, registerBuiltinTools as registerBuiltinToolsBase } from "../packages/agent-tools/src/index.js";
import { createPresentationState, projectEvent } from "../packages/agent-presentation/src/index.js";
import { AgentSupervisor } from "../packages/agent-supervisor/src/index.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";
import { registerContentValidator, validationTurn } from "./helpers/content-validator.js";
import { completeAgentEventPayload } from "./testkit/agent-event-fixtures.js";

const createRuntime = (options: Parameters<typeof createBaseRuntime>[0]) => createBaseRuntime({
  ...options,
  reviewer: createApprovingReviewer()
});

function registerBuiltinTools(
  registry: EffectToolRegistry,
  options: Parameters<typeof registerBuiltinToolsBase>[1] = {}
): EffectToolRegistry {
  return registerBuiltinToolsBase(registry, {
    ...options,
    repositoryList: options.repositoryList ?? repositoryListJsonLines
  });
}

function event(
  seq: number,
  type: AgentEventEnvelope["type"],
  payload: AgentEventEnvelope["payload"] = {}
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: `event-${seq}`,
    sessionId: "session",
    runId: "run",
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    type,
    authority: "runtime",
    payload: completeAgentEventPayload(type, payload)
  };
}

class FakeGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "fake";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response.");
    return response;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(request);
    if (response.message.content) yield { type: "content", delta: response.message.content };
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

function reopenRootPlan(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "reopen-root-plan",
        name: "update_plan",
        arguments: {
          expectedRevision: 2,
          goal: "Complete the second submitted instruction.",
          activeNodeId: "root",
          nodes: [{
            id: "root",
            title: "Complete the second run",
            dependencies: [],
            status: "in_progress",
            owner: { kind: "root" },
            acceptanceCriteria: ["The second instruction is completed with fresh evidence."],
            evidence: [],
            reopenReason: "The user submitted a new instruction after the first run completed."
          }]
        }
      }]
    },
    finishReason: "tool_calls"
  };
}

describe("Sigma architecture", () => {
  it("uses explicit completion rather than mutation heuristics", () => {
    let state = createKernelState({
      sessionId: "session",
      runId: "run",
      mode: "change",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60_000).toISOString()
    });
    state = evolve(state, event(1, "user.message", { text: "review and propose a refactor" }));
    state = evolve(state, event(2, "model.started", { turnId: 1, effectRevision: 1 }));
    state = evolve(state, event(3, "model.completed", {
      turnId: 1,
      effectRevision: 1,
      message: { role: "assistant", content: "", toolCalls: [{ id: "complete", name: "runtime_finalize", arguments: {} }] },
      toolCalls: [{ id: "complete", name: "runtime_finalize", arguments: {} }]
    }));
    state = evolve(state, event(4, "tool.completed", {
      turnId: 1, effectRevision: 1,
      callId: "complete", ok: true, output: JSON.stringify({ summary: "proposal" }),
      observedEffects: ["outcome.propose"], artifacts: [], diagnostics: [], startedAt: "start", completedAt: "end"
    }));
    expect(state.phase).toBe("outcome_pending");
    state = evolve(state, event(5, "run.completed", { message: "proposal", outcomeRevision: 4 }));
    expect(state.outcome).toMatchObject({ kind: "completed", message: "proposal" });
  });

  it("retrieves Chinese and mixed-language context", () => {
    expect(lexicalTokens("核心代理经常阻塞 agent")).toContain("核心");
    expect(lexicalScore("代理阻塞", "修复核心代理阻塞问题")).toBeGreaterThan(0.5);
  });

  it("never drops the newest user turn to make room for optional context", () => {
    const planned = planContext({
      system: [{ id: "contract", authority: "system", provenance: "contract", content: "system", tokenCount: 5, priority: 1_000 }],
      history: [{ role: "user", content: "This current request must remain visible." }],
      dynamic: [{ id: "large", authority: "tool", provenance: "repo", content: "large", tokenCount: 95, priority: 1_000 }],
      tools: [],
      contextWindowTokens: 100,
      outputReserveTokens: 0,
      promptCache: false
    });
    expect(planned.messages.at(-1)).toMatchObject({ role: "user", content: "This current request must remain visible." });
    expect(planned.omitted.map((item) => item.id)).toContain("large");
    expect(planned.messages[0]).toMatchObject({ role: "system" });
  });

  it("rejects workspace paths that escape through a directory link", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-workspace-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "sigma-external-"));
    await writeFile(path.join(external, "secret.txt"), "secret", "utf8");
    try {
      await symlink(external, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    await expect(resolveWorkspacePath(workspace, "linked/secret.txt")).rejects.toThrow(/outside workspace/);
  });

  it("stores checksummed segmented events and ignores only a torn tail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-store-"));
    const store = new SegmentedJsonlStore({ rootDir: root, segmentBytes: 6_000 });
    await store.append(event(1, "session.created"), 0);
    await store.append(event(2, "run.started"), 1);
    const eventsPath = path.join(sessionDirectory(root, "session"), "events", "000001.jsonl");
    await writeFile(eventsPath, `${await readFile(eventsPath, "utf8")}{"torn"`, "utf8");
    const restored: AgentEventEnvelope[] = [];
    for await (const restoredEvent of store.events("session")) restored.push(restoredEvent);
    expect(restored.map((item) => item.seq)).toEqual([1, 2]);
    await store.append(event(3, "diagnostic", { recovered: true }), 2);
    const afterAppend: AgentEventEnvelope[] = [];
    for await (const restoredEvent of store.events("session")) afterAppend.push(restoredEvent);
    expect(afterAppend.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("reconciles both store commit crash windows and serializes independent writers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-store-commit-"));
    const first = new SegmentedJsonlStore({ rootDir: root });
    const metaPath = path.join(sessionDirectory(root, "session"), "meta.json");
    await first.append(event(1, "session.created"), 0);
    await first.append(event(2, "diagnostic", { completeLine: true }), 1);

    const behind = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    await writeFile(metaPath, `${JSON.stringify({ ...behind, lastSeq: 1, segmentEvents: 1 })}\n`, "utf8");
    const recoveredAhead = new SegmentedJsonlStore({ rootDir: root });
    const replayed: number[] = [];
    for await (const stored of recoveredAhead.events("session")) replayed.push(stored.seq);
    expect(replayed).toEqual([1, 2]);
    await recoveredAhead.append(event(3, "diagnostic", { afterRecovery: true }), 2);

    const ahead = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    await writeFile(metaPath, `${JSON.stringify({ ...ahead, lastSeq: 4, segmentEvents: 4 })}\n`, "utf8");
    const recoveredBehind = new SegmentedJsonlStore({ rootDir: root });
    for await (const _stored of recoveredBehind.events("session")) { /* force reconciliation */ }
    await recoveredBehind.append(event(4, "diagnostic", { afterLostMeta: true }), 3);

    const writerA = new SegmentedJsonlStore({ rootDir: root });
    const writerB = new SegmentedJsonlStore({ rootDir: root });
    const contenders = await Promise.allSettled([
      writerA.append(event(5, "diagnostic", { writer: "a" }), 4),
      writerB.append(event(5, "diagnostic", { writer: "b" }), 4)
    ]);
    expect(contenders.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("runs a tool turn and completes in the new runtime", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-"));
    const gateway = new FakeGateway([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "write-1", name: "write", arguments: { path: "result.txt", content: "done" } }]
        },
        finishReason: "tool_calls"
      },
      validationTurn("validate-result", [{ path: "result.txt", expected: "done" }]),
      { message: { role: "assistant", content: "Implemented and verified." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write result.txt" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe("done");
    expect(gateway.requests).toHaveLength(3);
  });

  it("defers completion until final-state validation evidence is durable", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-completion-barrier-"));
    const gateway = new FakeGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "write-evidence", name: "write", arguments: { path: "result.txt", content: "done" } }]
      },
      finishReason: "tool_calls"
    },
    validationTurn("validate-same-turn-result", [{ path: "result.txt", expected: "done" }]),
    { message: { role: "assistant", content: "Wrote result.txt." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write result.txt" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed", message: "Wrote result.txt."
    });
    await expect(readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe("done");
    expect(gateway.requests).toHaveLength(3);
    const lifecycle: string[] = [];
    for await (const stored of store.events(session.sessionId)) {
      if (stored.type.startsWith("tool.")) {
        const payload = stored.payload as Record<string, unknown>;
        lifecycle.push(`${stored.type}:${String(payload.callId)}`);
      }
    }
    const completionRequest = lifecycle.findIndex((item) =>
      item.startsWith("tool.requested:runtime_completion_intent_"));
    expect(lifecycle.indexOf("tool.completed:validate-same-turn-result"))
      .toBeLessThan(completionRequest);
  });

  it("recovers after an evidence tool fails before completion", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-completion-failure-barrier-"));
    const gateway = new FakeGateway([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "failed-evidence", name: "missing_tool", arguments: {} }]
        },
        finishReason: "tool_calls"
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "valid-evidence", name: "list", arguments: { path: ".", limit: 20 } }]
        },
        finishReason: "tool_calls"
      },
      { message: { role: "assistant", content: "Finished after valid evidence." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "verify failure barrier" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed", message: "Finished after valid evidence."
    });
    const events: AgentEventEnvelope[] = [];
    for await (const stored of store.events(session.sessionId)) events.push(stored);
    expect(events.find((stored) => stored.type === "tool.failed"
      && (stored.payload as { callId?: string }).callId === "failed-evidence")?.payload)
      .toMatchObject({ diagnostics: ["unknown_tool"] });
    expect(events.filter((stored) => stored.type === "run.completed")).toHaveLength(1);
  });

  it("exposes human-readable completion status without internal evidence ids", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-completion-guidance-"));
    await writeFile(path.join(workspace, "result.txt"), "done", "utf8");
    const proposal = (id: string): ModelResponse => ({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id,
          name: "runtime_finalize",
          arguments: { summary: "Verified result.txt.", evidenceId: "invented-evidence" }
        }]
      },
      finishReason: "tool_calls"
    });
    const gateway = new FakeGateway([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-evidence", name: "read", arguments: { path: "result.txt" } }]
        },
        finishReason: "tool_calls"
      },
      proposal("invalid-completion"),
      { message: { role: "assistant", content: "Verified result.txt." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "verify result.txt" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(gateway.requests[1].messages.some((message) =>
      message.content.includes("completion_status"))).toBe(true);
    expect(gateway.requests.flatMap((request) => request.messages)
      .every((message) => !message.content.includes("Current-run typed durable evidence ledger."))).toBe(true);
  });

  it("serializes durable events emitted by parallel tool calls", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-parallel-"));
    await writeFile(path.join(workspace, "a.txt"), "a", "utf8");
    await writeFile(path.join(workspace, "b.txt"), "b", "utf8");
    const gateway = new FakeGateway([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "read-a", name: "read", arguments: { path: "a.txt" } },
            { id: "read-b", name: "read", arguments: { path: "b.txt" } }
          ]
        },
        finishReason: "tool_calls"
      },
      { message: { role: "assistant", content: "Both files were read." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "read both files", mode: "analyze" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const sequences: number[] = [];
    for await (const stored of store.events(session.sessionId)) sequences.push(stored.seq);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it("rehydrates the most recent outcome across multiple runs", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-resume-"));
    const storeRootDir = path.join(workspace, ".agent");
    const gateway = new FakeGateway([
      { message: { role: "assistant", content: "first" }, finishReason: "stop" },
      reopenRootPlan(),
      { message: { role: "assistant", content: "second" }, finishReason: "stop" }
    ]);
    const firstRuntime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await firstRuntime.createSession({ workspacePath: workspace, mode: "change" });
    await firstRuntime.command({ type: "submit", sessionId: session.sessionId, text: "one" });
    await expect(firstRuntime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed", message: "first" });
    await firstRuntime.command({ type: "submit", sessionId: session.sessionId, text: "two" });
    await expect(firstRuntime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed", message: "second" });
    const secondRunFirstRequest = gateway.requests[1];
    expect(secondRunFirstRequest.messages.some((message) =>
      message.content.includes("completion_status"))).toBe(true);
    expect(gateway.requests).toHaveLength(3);

    const resumed = createRuntime({
      gateway: new FakeGateway([]),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    await resumed.command({ type: "resume", sessionId: session.sessionId });
    await expect(resumed.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed", message: "second" });
  });

  it("finishes an outcome-pending crash boundary and never extends a durable deadline", async () => {
    const pendingWorkspace = await mkdtemp(path.join(os.tmpdir(), "sigma-outcome-pending-"));
    const pendingRoot = path.join(pendingWorkspace, ".agent");
    const pendingStore = new SegmentedJsonlStore({ rootDir: pendingRoot });
    const future = new Date(Date.now() + 10_000).toISOString();
    const pendingEvents = [
      event(1, "session.created", { workspacePath: pendingWorkspace, mode: "change" }),
      event(2, "run.started", { mode: "change", deadlineAt: future }),
      event(3, "user.message", { text: "finish" }),
      event(4, "model.started", { turnId: 1, effectRevision: 3 }),
      event(5, "model.completed", {
        turnId: 1, effectRevision: 3,
        message: { role: "assistant", content: "", toolCalls: [{
          id: "runtime_completion_intent_1_3", name: "runtime_finalize", arguments: { summary: "already generated" }
        }] },
        toolCalls: [{
          id: "runtime_completion_intent_1_3", name: "runtime_finalize", arguments: { summary: "already generated" }
        }], finishReason: "tool_calls"
      }),
      event(6, "tool.completed", {
        turnId: 1, effectRevision: 3,
        callId: "runtime_completion_intent_1_3", ok: true, output: JSON.stringify({ summary: "already generated" }),
        observedEffects: ["outcome.propose"], artifacts: [], diagnostics: [], startedAt: "start", completedAt: "end"
      })
    ];
    for (const stored of pendingEvents) await pendingStore.append(stored, stored.seq - 1);
    const pendingRuntime = createRuntime({
      gateway: new FakeGateway([]), store: pendingStore, storeRootDir: pendingRoot,
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 60_000
    });
    await pendingRuntime.command({ type: "resume", sessionId: "session" });
    await expect(pendingRuntime.waitForOutcome("session")).resolves.toMatchObject({ kind: "completed", message: "already generated" });

    const expiredWorkspace = await mkdtemp(path.join(os.tmpdir(), "sigma-expired-resume-"));
    const expiredRoot = path.join(expiredWorkspace, ".agent");
    const expiredStore = new SegmentedJsonlStore({ rootDir: expiredRoot });
    const expiredEvents = [
      event(1, "session.created", { workspacePath: expiredWorkspace, mode: "change" }),
      event(2, "run.started", { mode: "change", deadlineAt: new Date(Date.now() - 1_000).toISOString() }),
      event(3, "user.message", { text: "do not extend this run" })
    ];
    for (const stored of expiredEvents) await expiredStore.append(stored, stored.seq - 1);
    const expiredRuntime = createRuntime({
      gateway: new FakeGateway([]), store: expiredStore, storeRootDir: expiredRoot,
      tools: registerBuiltinTools(new EffectToolRegistry()), permissionMode: "auto", runDeadlineMs: 60_000
    });
    await expiredRuntime.command({ type: "resume", sessionId: "session" });
    await expect(expiredRuntime.waitForOutcome("session")).resolves.toMatchObject({ kind: "recoverable_failure", code: "budget_exhausted" });
  });

  it("cancels a run waiting for approval without hanging", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cancel-"));
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway: new FakeGateway([{
        message: { role: "assistant", content: "", toolCalls: [{ id: "write", name: "write", arguments: { path: "x.txt", content: "x" } }] },
        finishReason: "tool_calls"
      }]),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const approvalSeen = (async () => {
      for await (const stored of runtime.subscribe(session.sessionId)) {
        if (stored.type === "tool.approval_requested") return;
      }
    })();
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "write x" });
    await approvalSeen;
    const started = Date.now();
    await sendSessionCommand(storeRootDir, { type: "cancel", sessionId: session.sessionId, reason: "test cancellation" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "cancelled" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("restores a durable pending approval and continues after approval", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-approval-resume-"));
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const restoredPlan = {
      exactEffects: ["filesystem.read", "filesystem.write"],
      readPaths: ["restored.txt"],
      writePaths: ["restored.txt"],
      network: "none",
      processMode: "none",
      checkpointScope: ["restored.txt"],
      idempotence: "replay_safe"
    };
    const persisted = [
      event(1, "session.created", { workspacePath: workspace, mode: "change" }),
      event(2, "plan.updated", {
        previousRevision: 0,
        plan: {
          revision: 1,
          goal: "write restored.txt",
          activeNodeId: "root",
          nodes: [{
            id: "root",
            title: "write restored.txt",
            dependencies: [],
            status: "in_progress",
            owner: { kind: "root" },
            acceptanceCriteria: ["restored.txt contains ok"],
            evidence: []
          }]
        }
      }),
      event(3, "run.started", { mode: "change" }),
      event(4, "user.message", { text: "write restored.txt" }),
      event(5, "model.started", { turnId: 1, effectRevision: 4 }),
      event(6, "model.completed", {
        turnId: 1, effectRevision: 4,
        message: { role: "assistant", content: "", toolCalls: [{ id: "restored-write", name: "write", arguments: { path: "restored.txt", content: "ok" } }] },
        finishReason: "tool_calls",
        toolCalls: [{ id: "restored-write", name: "write", arguments: { path: "restored.txt", content: "ok" } }]
      }),
      event(7, "tool.requested", { turnId: 1, effectRevision: 4, callId: "restored-write", name: "write", arguments: { path: "restored.txt", content: "ok" } }),
      event(8, "execution.planned", {
        executionId: "restored-write", toolCallId: "restored-write", plan: restoredPlan
      }),
      event(9, "tool.approval_requested", {
        turnId: 1, effectRevision: 4, requestId: "restored-write", callId: "restored-write",
        toolName: "write", arguments: { path: "restored.txt", content: "ok" },
        effects: ["filesystem.read", "filesystem.write"], plan: restoredPlan
      }),
      event(10, "run.suspended", { turnId: 1, effectRevision: 4, requestId: "restored-write", callId: "restored-write", message: "approval required" })
    ];
    for (const stored of persisted) await store.append(stored, stored.seq - 1);
    const runtime = createRuntime({
      gateway: new FakeGateway([
        validationTurn("validate-restored-write", [{ path: "restored.txt", expected: "ok" }]),
        { message: { role: "assistant", content: "restored" }, finishReason: "stop" }
      ]),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    await runtime.command({ type: "resume", sessionId: "session" });
    await runtime.command({ type: "approve", sessionId: "session", requestId: "restored-write", decision: "allow" });
    await expect(runtime.waitForOutcome("session")).resolves.toMatchObject({ kind: "completed", message: "restored" });
    await expect(readFile(path.join(workspace, "restored.txt"), "utf8")).resolves.toBe("ok");
  });

  it("can deny or cancel an approval restored after a crash", async () => {
    const createSuspendedStore = async (workspace: string): Promise<{ storeRootDir: string; store: SegmentedJsonlStore }> => {
      const storeRootDir = path.join(workspace, ".agent");
      const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
      const persisted = [
        event(1, "session.created", { workspacePath: workspace, mode: "change" }),
        event(2, "run.started", { mode: "change" }),
        event(3, "user.message", { text: "write result" }),
        event(4, "model.started", { turnId: 1, effectRevision: 3 }),
        event(5, "model.completed", {
          turnId: 1, effectRevision: 3,
          message: { role: "assistant", content: "", toolCalls: [{ id: "pending-write", name: "write", arguments: { path: "result.txt", content: "x" } }] },
          finishReason: "tool_calls",
          toolCalls: [{ id: "pending-write", name: "write", arguments: { path: "result.txt", content: "x" } }]
        }),
        event(6, "tool.requested", { turnId: 1, effectRevision: 3, callId: "pending-write", name: "write", arguments: { path: "result.txt", content: "x" } }),
        event(7, "tool.approval_requested", { turnId: 1, effectRevision: 3, requestId: "pending-write", callId: "pending-write", toolName: "write" }),
        event(8, "run.suspended", { turnId: 1, effectRevision: 3, requestId: "pending-write", callId: "pending-write", message: "approval required" })
      ];
      for (const stored of persisted) await store.append(stored, stored.seq - 1);
      return { storeRootDir, store };
    };

    const deniedWorkspace = await mkdtemp(path.join(os.tmpdir(), "sigma-deny-resume-"));
    const deniedStore = await createSuspendedStore(deniedWorkspace);
    const deniedRuntime = createRuntime({
      gateway: new FakeGateway([{ message: { role: "assistant", content: "continued safely" }, finishReason: "stop" }]),
      store: deniedStore.store,
      storeRootDir: deniedStore.storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    await deniedRuntime.command({ type: "resume", sessionId: "session" });
    await deniedRuntime.command({ type: "approve", sessionId: "session", requestId: "pending-write", decision: "deny" });
    await expect(deniedRuntime.waitForOutcome("session")).resolves.toMatchObject({ kind: "completed", message: "continued safely" });
    await expect(readFile(path.join(deniedWorkspace, "result.txt"), "utf8")).rejects.toThrow();

    const cancelledWorkspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cancel-resume-"));
    const cancelledStore = await createSuspendedStore(cancelledWorkspace);
    const cancelledRuntime = createRuntime({
      gateway: new FakeGateway([]),
      store: cancelledStore.store,
      storeRootDir: cancelledStore.storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    await cancelledRuntime.command({ type: "resume", sessionId: "session" });
    await cancelledRuntime.command({ type: "cancel", sessionId: "session", reason: "do not retry" });
    await expect(cancelledRuntime.waitForOutcome("session")).resolves.toMatchObject({ kind: "cancelled", reason: "do not retry" });

    const durableDeniedWorkspace = await mkdtemp(path.join(os.tmpdir(), "sigma-durable-deny-resume-"));
    const durableDeniedStore = await createSuspendedStore(durableDeniedWorkspace);
    await durableDeniedStore.store.append({
      ...event(9, "tool.approval_resolved", {
        turnId: 1,
        effectRevision: 3,
        requestId: "pending-write",
        callId: "pending-write",
        decision: "deny"
      }),
      authority: "user"
    }, 8);
    const durableDeniedRuntime = createRuntime({
      gateway: new FakeGateway([{ message: { role: "assistant", content: "durable denial settled" }, finishReason: "stop" }]),
      store: durableDeniedStore.store,
      storeRootDir: durableDeniedStore.storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    await durableDeniedRuntime.command({ type: "resume", sessionId: "session" });
    await expect(durableDeniedRuntime.waitForOutcome("session")).resolves.toMatchObject({
      kind: "completed", message: "durable denial settled"
    });
    await expect(readFile(path.join(durableDeniedWorkspace, "result.txt"), "utf8")).rejects.toThrow();
    const durableDeniedEvents: AgentEventEnvelope[] = [];
    for await (const stored of durableDeniedStore.store.events("session")) durableDeniedEvents.push(stored);
    expect(durableDeniedEvents.some((stored) => stored.type === "tool.failed"
      && (stored.payload as { diagnostics?: string[] }).diagnostics?.includes("recovery_retry_denied"))).toBe(true);
  });

  it("normalizes a throwing tool into a protocol receipt", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-tool-error-"));
    const gateway = new FakeGateway([
      { message: { role: "assistant", content: "", toolCalls: [{ id: "boom", name: "explode", arguments: {} }] }, finishReason: "tool_calls" },
      { message: { role: "assistant", content: "Recovered from tool failure." }, finishReason: "stop" }
    ]);
    const tools = registerBuiltinTools(new EffectToolRegistry());
    tools.register({
      descriptor: {
        name: "explode",
        description: "test tool",
        inputSchema: { type: "object" },
        possibleEffects: ["filesystem.read"],
        executionMode: "parallel",
        resourceKeys: [],
        approval: "auto",
        idempotent: true,
        timeoutMs: 1_000
      },
      async execute() { throw new Error("expected explosion"); }
    });
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "invoke failure", mode: "analyze" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(gateway.requests[1].messages.some((message) => message.role === "tool" && message.content.includes("expected explosion"))).toBe(true);
  });

  it("enforces a hard tool deadline even when a plugin ignores cancellation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-tool-timeout-"));
    const gateway = new FakeGateway([
      { message: { role: "assistant", content: "", toolCalls: [{ id: "hang", name: "never_returns", arguments: {} }] }, finishReason: "tool_calls" },
      { message: { role: "assistant", content: "Handled the timeout." }, finishReason: "stop" }
    ]);
    const tools = registerBuiltinTools(new EffectToolRegistry());
    tools.register({
      descriptor: {
        name: "never_returns", description: "test deadline", inputSchema: { type: "object" },
        possibleEffects: ["filesystem.read"], executionMode: "parallel", resourceKeys: [],
        approval: "auto", idempotent: true, timeoutMs: 25
      },
      async execute() { return await new Promise(() => undefined); }
    });
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway, store: new SegmentedJsonlStore({ rootDir: storeRootDir }), storeRootDir, tools,
      permissionMode: "auto", runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    const deadlineObserved = (async (): Promise<number> => {
      for await (const stored of runtime.subscribe(session.sessionId)) {
        if (stored.type === "tool.failed"
          && (stored.payload as { callId?: string }).callId === "hang") return Date.now();
      }
      throw new Error("Runtime event stream ended before the deadline receipt.");
    })();
    const started = Date.now();
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "exercise timeout", mode: "analyze" });
    const failedAt = await Promise.race([
      deadlineObserved,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("Tool deadline receipt exceeded 1.5 seconds.")),
        1_500
      ))
    ]);
    expect(failedAt - started).toBeLessThan(1_500);
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(gateway.requests[1].messages.some((message) => message.role === "tool"
      && message.content.includes("exceeded its 25ms deadline-bounded timeout"))).toBe(true);
  });

  it("projects later streaming turns without historical messages clearing them", () => {
    let state = createPresentationState();
    state = projectEvent(state, event(1, "model.delta", { delta: "first" }));
    state = projectEvent(state, event(2, "model.completed", { text: "first" }));
    const second = { ...event(3, "model.delta", { delta: "second" }), runId: "run-2" };
    state = projectEvent(state, second);
    expect(state.transcript.at(-1)).toMatchObject({ text: "second", streaming: true });
  });

  it("delivers child follow-ups through a real mailbox", async () => {
    const supervisor = new AgentSupervisor(async (context) => {
      for await (const message of context.mailbox) {
        if (message.type === "follow_up") {
          return { childId: context.childId, outcome: { kind: "completed", message: message.text ?? "", evidence: [] }, report: null };
        }
      }
      throw new Error("mailbox closed");
    }, 1);
    const child = supervisor.spawn({ parentId: "parent", instruction: "inspect", workspacePath: "." });
    const deadline = Date.now() + 1_000;
    while (supervisor.list("parent")[0]?.status !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    supervisor.followUp(child.id, "new evidence");
    await expect(supervisor.join(child.id)).resolves.toMatchObject({
      status: "completed",
      result: { outcome: { kind: "completed", message: "new evidence" } }
    });
  });
});
