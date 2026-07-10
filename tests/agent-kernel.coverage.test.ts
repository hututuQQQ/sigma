import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, AgentEventType, JsonValue } from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  createKernelState,
  decide,
  evolve,
  isStaleEffect,
  isTerminal,
  rehydrate,
  type KernelState
} from "../packages/agent-kernel/src/index.js";

function initial(): KernelState {
  return createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T00:01:00.000Z"
  });
}

function envelope(state: KernelState, type: AgentEventType, payload: JsonValue = {}): AgentEventEnvelope {
  return {
    schemaVersion: 2,
    seq: state.lastSeq + 1,
    eventId: `event-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    authority: "runtime",
    payload
  };
}

function apply(state: KernelState, type: AgentEventType, payload: JsonValue = {}): KernelState {
  return evolve(state, envelope(state, type, payload));
}

function startModel(state: KernelState, turnId = 1): KernelState {
  return apply(state, "model.started", { turnId, effectRevision: state.revision });
}

function settleModel(
  state: KernelState,
  type: "model.completed" | "model.failed",
  payload: Record<string, JsonValue>
): KernelState {
  if (!state.activeModelTurn) throw new Error("Test model turn was not active.");
  return apply(state, type, { ...payload, ...state.activeModelTurn });
}

function withPendingTool(callId: string, name: string, argumentsValue: JsonValue = null): KernelState {
  const inFlight = startModel(apply(initial(), "user.message", { text: "tool request" }));
  return settleModel(inFlight, "model.completed", {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name, arguments: argumentsValue }]
    },
    toolCalls: [{ id: callId, name, arguments: argumentsValue }],
    finishReason: "tool_calls"
  });
}

function toolEvent(
  state: KernelState,
  type: "tool.requested" | "tool.approval_requested" | "tool.approval_resolved" | "tool.started" | "tool.completed" | "tool.failed",
  callId: string,
  payload: Record<string, JsonValue> = {}
): KernelState {
  const pending = state.pendingTools.find((item) => item.request.callId === callId);
  if (!pending) throw new Error(`Test pending tool '${callId}' was not found.`);
  return apply(state, type, { callId, ...payload, ...pending.modelTurn });
}

describe("agent-kernel exhaustive protocol behavior", () => {
  it("decides every phase and rejects stale effects", () => {
    const base = initial();
    expect(isTerminal(base)).toBe(false);
    expect(decide(base)).toEqual([]);

    const ready = { ...base, phase: "ready_model" as const, revision: 2, messages: [{ role: "user" as const, content: "x" }] };
    const request = decide(ready)[0];
    expect(request).toMatchObject({ type: "request_model", revision: 2 });
    expect(isStaleEffect(ready, request)).toBe(false);
    expect(isStaleEffect({ ...ready, revision: 3 }, request)).toBe(true);

    const proposed = { ...base, phase: "outcome_pending" as const, proposedOutcome: { kind: "completed" as const, message: "done", evidence: [] } };
    expect(decide(proposed)).toEqual([{ type: "finish_run", revision: 0, outcome: proposed.proposedOutcome }]);
    expect(decide({ ...proposed, proposedOutcome: undefined })).toEqual([]);

    const requestTool = { callId: "a", name: "read", arguments: null };
    const modelTurn = { turnId: 1, effectRevision: 1 };
    const tools = {
      ...base,
      phase: "tool_pending" as const,
      pendingTools: [
        { request: requestTool, modelTurn, approval: "not_required" as const, started: false },
        { request: { ...requestTool, callId: "b" }, modelTurn, approval: "allowed" as const, started: false },
        { request: { ...requestTool, callId: "c" }, modelTurn, approval: "pending" as const, started: false },
        { request: { ...requestTool, callId: "d" }, modelTurn, approval: "denied" as const, started: false },
        { request: { ...requestTool, callId: "e" }, modelTurn, approval: "allowed" as const, started: true }
      ]
    };
    expect(decide(tools).map((item) => item.type)).toEqual(["execute_tool", "execute_tool"]);

    const terminal = { ...base, phase: "terminal" as const, outcome: { kind: "cancelled" as const, reason: "x" } };
    expect(isTerminal(terminal)).toBe(true);
    expect(decide(terminal)).toEqual([{ type: "publish_outcome", revision: 0 }]);
    expect(decide({ ...terminal, outcome: undefined })).toEqual([]);
    expect(isStaleEffect(terminal, request)).toBe(true);
  });

  it("reduces model, user, and terminal event variants", () => {
    let state = initial();
    state = apply(state, "session.created");
    state = apply(state, "run.started");
    expect(state.phase).toBe("idle");
    for (const type of ["user.message", "user.steer", "user.follow_up"] as const) {
      state = apply(state, type, { text: type });
    }
    expect(state.messages).toHaveLength(3);
    state = apply(state, "run.started");
    expect(state.phase).toBe("ready_model");
    state = startModel(state);
    expect(state.phase).toBe("model_in_flight");
    state = settleModel(state, "model.completed", {
      message: {
        role: "assistant",
        content: "",
        reasoningContent: "provider reasoning",
        toolCallId: "source",
        toolCalls: [null, { nope: true }, { id: "call", name: "read", arguments: { path: "x" } }]
      },
      toolCalls: [null, "bad", { nope: true }, { id: "call", name: "read", arguments: { path: "x" } }],
      finishReason: "tool_calls"
    });
    expect(state.phase).toBe("tool_pending");
    expect(state.pendingTools[0].request.callId).toBe("call");
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      reasoningContent: "provider reasoning",
      toolCallId: "source"
    });
    state = apply(state, "user.steer", { text: "preserve pending work" });
    expect(state.phase).toBe("ready_model");
    expect(state.pendingTools).toEqual([]);
    expect(state.messages.at(-2)).toMatchObject({
      role: "tool",
      toolCallId: "call",
      content: expect.stringContaining("Superseded by a newer user instruction")
    });
    expect(() => settleModel(startModel(apply(initial(), "user.message", { text: "duplicate" })), "model.completed", {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "duplicate", name: "read" }, { id: "duplicate", name: "read" }]
    })).toThrow("duplicate tool call id");

    const inFlight = (): KernelState => startModel(apply(initial(), "user.message", { text: "request" }));
    const length = settleModel(inFlight(), "model.completed", { message: { role: "assistant", content: "partial" }, toolCalls: [], finishReason: "length" });
    expect(length.phase).toBe("ready_model");
    const filtered = settleModel(inFlight(), "model.completed", { message: { role: "assistant", content: "" }, toolCalls: [], finishReason: "content_filter" });
    expect(filtered.proposedOutcome).toMatchObject({ kind: "fatal", code: "content_filter" });
    let incomplete = settleModel(inFlight(), "model.completed", { message: { role: "assistant", content: "answer" }, toolCalls: [], finishReason: "stop" });
    expect(incomplete.phase).toBe("ready_model");
    expect(incomplete.messages.at(-1)).toMatchObject({ role: "developer" });
    incomplete = settleModel(inFlight(), "model.completed", { message: { role: "invalid" }, text: "fallback", toolCalls: [] });
    expect(incomplete.phase).toBe("ready_model");
    incomplete = settleModel(inFlight(), "model.completed", { message: null, toolCalls: [] });
    expect(incomplete.phase).toBe("ready_model");

    const modelFailure = settleModel(inFlight(), "model.failed", { message: "network" });
    expect(modelFailure.proposedOutcome).toMatchObject({ kind: "recoverable_failure", code: "model_error" });
    expect(settleModel(inFlight(), "model.failed", { code: "overload", message: "retry" }).proposedOutcome).toMatchObject({ code: "overload" });

    let superseded = startModel(apply(initial(), "user.message", { text: "initial request" }), 11);
    const staleTurn = superseded.activeModelTurn!;
    superseded = apply(superseded, "user.steer", { text: "new instruction" });
    const afterStaleFailure = apply(superseded, "model.failed", {
      ...staleTurn, code: "network", message: "failure from old turn"
    });
    expect(afterStaleFailure.phase).toBe("ready_model");
    expect(afterStaleFailure.proposedOutcome).toBeUndefined();
    const current = startModel(afterStaleFailure, 12);
    const afterStaleCompletion = apply(current, "model.completed", {
      ...staleTurn,
      message: { role: "assistant", content: "obsolete" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(afterStaleCompletion).toMatchObject({ phase: "model_in_flight", activeModelTurn: { turnId: 12 } });
    const afterStaleRestart = apply(afterStaleCompletion, "diagnostic", { kind: "steering.restart", ...staleTurn });
    expect(afterStaleRestart).toMatchObject({ phase: "model_in_flight", activeModelTurn: { turnId: 12 } });
    const currentCompleted = settleModel(current, "model.completed", {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "current-call", name: "read", arguments: { path: "current.txt" } }]
      },
      toolCalls: [{ id: "current-call", name: "read", arguments: { path: "current.txt" } }],
      finishReason: "tool_calls"
    });
    const restartAfterCompletion = apply(currentCompleted, "diagnostic", {
      kind: "steering.restart", ...staleTurn
    });
    expect(restartAfterCompletion).toMatchObject({
      phase: "tool_pending",
      pendingTools: [{ request: { callId: "current-call" } }]
    });

    const cancelled = apply(initial(), "run.cancelled", {});
    expect(cancelled.outcome).toEqual({ kind: "cancelled", reason: "cancelled" });
    expect(apply(initial(), "run.cancelled", { reason: "user" }).outcome).toMatchObject({ reason: "user" });
    expect(apply(initial(), "run.failed", { kind: "recoverable_failure", code: "retry", message: "later", resumeToken: "r" }).outcome)
      .toEqual({ kind: "recoverable_failure", code: "retry", message: "later", resumeToken: "r" });
    expect(apply(initial(), "run.failed", { kind: "fatal" }).outcome).toMatchObject({ kind: "fatal", code: "runtime_error" });
    expect(apply(initial(), "run.completed", { message: "ok" }).outcome).toMatchObject({ kind: "completed", message: "ok" });

    const terminalEvent = envelope(cancelled, "diagnostic");
    expect(evolve(cancelled, terminalEvent)).toBe(cancelled);
    expect(() => evolve(initial(), { ...envelope(initial(), "diagnostic"), sessionId: "other" })).toThrow("session mismatch");
    expect(() => evolve(initial(), { ...envelope(initial(), "diagnostic"), seq: 0 })).toThrow("must increase");
  });

  it("preserves tool-call/result invariants across approval and recovery", () => {
    let state = apply(initial(), "tool.requested", null);
    expect(state.pendingTools).toEqual([]);
    state = apply(state, "tool.requested", { callId: 1, name: "read" });
    expect(state.pendingTools).toEqual([]);
    state = withPendingTool("call", "read");
    state = apply(state, "tool.requested", { callId: "call", name: "read" });
    expect(state.pendingTools).toHaveLength(1);

    state = toolEvent(state, "tool.approval_requested", "call");
    expect(state.phase).toBe("needs_input");
    state = toolEvent(state, "tool.approval_resolved", "call", { decision: "allow" });
    expect(state.pendingTools[0].approval).toBe("allowed");
    state = toolEvent(state, "tool.started", "call");
    expect(state.phase).toBe("tool_in_flight");
    state = apply(state, "diagnostic", { kind: "recovery.reset_tool", callId: "call", approval: "pending" });
    expect(state).toMatchObject({ phase: "needs_input", pendingTools: [{ started: false, approval: "pending" }] });
    state = toolEvent(state, "tool.approval_resolved", "call", { decision: "always_allow" });
    state = toolEvent(state, "tool.completed", "call", {
      ok: true, output: "contents", observedEffects: ["filesystem.read"], artifacts: [], diagnostics: [],
      startedAt: "start", completedAt: "end"
    });
    expect(state).toMatchObject({ phase: "ready_model", receipts: [{ callId: "call", ok: true }] });
    expect(state.evidence).toHaveLength(1);
    expect(state.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call" });
    expect(state.messages.at(-1)?.content).toBe("Successful tool receipt ID: call\ncontents");

    let completion = withPendingTool("complete", "complete_task");
    completion = toolEvent(completion, "tool.completed", "complete", {
      ok: true, output: JSON.stringify({ summary: "evidence-backed result" }),
      observedEffects: ["outcome.propose"], artifacts: ["artifact"], diagnostics: ["checked"], startedAt: "start", completedAt: "end"
    });
    expect(completion).toMatchObject({ phase: "outcome_pending", proposedOutcome: { kind: "completed", message: "evidence-backed result" } });
    const committedRevision = completion.revision;
    expect(apply(completion, "run.completed", {
      message: "committed", outcomeRevision: committedRevision
    })).toMatchObject({ phase: "terminal", outcome: { kind: "completed", message: "committed" } });
    expect(apply(completion, "run.completed", {
      message: "stale", outcomeRevision: committedRevision - 1
    })).toMatchObject({ phase: "outcome_pending", proposedOutcome: { message: "evidence-backed result" } });
    expect(apply(completion, "run.failed", {
      kind: "fatal", message: "stale failure", outcomeRevision: committedRevision - 1
    })).toMatchObject({ phase: "outcome_pending", proposedOutcome: { message: "evidence-backed result" } });
    expect(apply(initial(), "run.completed", {
      message: "wrong phase", outcomeRevision: initial().revision
    }).phase).toBe("idle");

    let denied = withPendingTool("deny", "write");
    denied = toolEvent(denied, "tool.approval_resolved", "deny", { decision: "deny" });
    expect(denied.pendingTools[0].approval).toBe("denied");
    denied = toolEvent(denied, "tool.failed", "deny", { ok: false, output: 42 });
    expect(denied.evidence).toHaveLength(0);
    expect(denied.messages.at(-1)?.content).toBe("Failed tool receipt ID: deny\n");

    const invalidReceipt = apply(initial(), "tool.failed", null);
    expect(invalidReceipt.receipts).toEqual([]);
    const suspended = apply(initial(), "run.suspended", { requestId: "approval", message: "choose" });
    expect(suspended.outcome).toEqual({ kind: "needs_input", requestId: "approval", message: "choose" });
    expect(apply(initial(), "diagnostic", { kind: "recovery.retry_model" }).phase).toBe("ready_model");
    expect(apply(initial(), "diagnostic", { kind: "other" }).phase).toBe("idle");
    expect(apply(initial(), "context.compacted", []).phase).toBe("idle");

    let superseded = withPendingTool("complete-race", "complete_task");
    const staleToolTurn = superseded.pendingTools[0].modelTurn;
    superseded = apply(superseded, "user.steer", { text: "new acceptance criteria" });
    superseded = apply(superseded, "tool.completed", {
      callId: "complete-race",
      ...staleToolTurn,
      ok: true,
      output: JSON.stringify({ summary: "obsolete completion" }),
      observedEffects: ["outcome.propose"],
      artifacts: [], diagnostics: [], startedAt: "start", completedAt: "end"
    });
    expect(superseded).toMatchObject({ phase: "ready_model", pendingTools: [], receipts: [] });
    expect(superseded.proposedOutcome).toBeUndefined();
    expect(superseded.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "complete-race"
      && message.content.includes("Superseded"))).toBe(true);

    let guarded = withPendingTool("guarded", "write");
    const staleLifecycle = {
      callId: "guarded",
      turnId: guarded.pendingTools[0].modelTurn.turnId + 1,
      effectRevision: guarded.pendingTools[0].modelTurn.effectRevision
    };
    guarded = apply(guarded, "tool.approval_requested", staleLifecycle);
    guarded = apply(guarded, "tool.approval_resolved", { ...staleLifecycle, decision: "allow" });
    guarded = apply(guarded, "tool.started", staleLifecycle);
    guarded = apply(guarded, "run.suspended", {
      ...staleLifecycle, requestId: "stale", message: "obsolete approval"
    });
    expect(guarded).toMatchObject({
      phase: "tool_pending",
      pendingTools: [{ approval: "not_required", started: false }]
    });
  });

  it("rehydrates deterministically and checks state invariants", () => {
    const first = envelope(initial(), "user.message", { text: "hello" });
    const second = { ...envelope({ ...initial(), lastSeq: 1 }, "model.started", { turnId: 1, effectRevision: 1 }), seq: 2 };
    const restored = rehydrate(initial(), [first, second]);
    expect(restored).toMatchObject({ phase: "model_in_flight", lastSeq: 2, revision: 2 });
    expect(() => assertKernelInvariants({
      ...initial(), phase: "tool_pending",
      pendingTools: [
        { request: { callId: "same", name: "a", arguments: null }, modelTurn: { turnId: 1, effectRevision: 1 }, approval: "allowed", started: false },
        { request: { callId: "same", name: "b", arguments: null }, modelTurn: { turnId: 1, effectRevision: 1 }, approval: "allowed", started: false }
      ]
    })).toThrow("Duplicate pending");
    expect(() => assertKernelInvariants({ ...initial(), phase: "terminal" })).toThrow("requires an outcome");
    expect(() => assertKernelInvariants({ ...initial(), outcome: { kind: "fatal", code: "x", message: "x" } })).toThrow("Non-terminal");
    expect(() => assertKernelInvariants({
      ...initial(),
      phase: "tool_pending",
      pendingTools: [{
        request: { callId: "invalid-turn", name: "read", arguments: null },
        modelTurn: { turnId: Number.NaN, effectRevision: 1 },
        approval: "allowed",
        started: false
      }]
    })).toThrow("valid originating model turn");
    expect(() => assertKernelInvariants({
      ...initial(), activeModelTurn: { turnId: 1, effectRevision: 1 }
    })).toThrow("active model turn must agree");
    expect(() => assertKernelInvariants({
      ...initial(), phase: "model_in_flight"
    })).toThrow("active model turn must agree");
    expect(() => assertKernelInvariants({ ...initial(), phase: "needs_input", outcome: { kind: "needs_input", requestId: "x", message: "x" } })).not.toThrow();
    expect(() => assertKernelInvariants({ ...initial(), phase: "terminal", outcome: { kind: "completed", message: "x", evidence: [] } })).not.toThrow();
  });
});
