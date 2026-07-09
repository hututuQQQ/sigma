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
    const tools = {
      ...base,
      phase: "tool_pending" as const,
      pendingTools: [
        { request: requestTool, approval: "not_required" as const, started: false },
        { request: { ...requestTool, callId: "b" }, approval: "allowed" as const, started: false },
        { request: { ...requestTool, callId: "c" }, approval: "pending" as const, started: false },
        { request: { ...requestTool, callId: "d" }, approval: "denied" as const, started: false },
        { request: { ...requestTool, callId: "e" }, approval: "allowed" as const, started: true }
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
    state = apply(state, "model.started");
    expect(state.phase).toBe("model_in_flight");
    state = apply(state, "model.completed", {
      message: {
        role: "assistant",
        content: "",
        toolCallId: "source",
        toolCalls: [null, { nope: true }, { id: "call", name: "read", arguments: { path: "x" } }]
      },
      toolCalls: [null, "bad", { nope: true }, { id: "call", name: "read", arguments: { path: "x" } }],
      finishReason: "tool_calls"
    });
    expect(state.phase).toBe("tool_pending");
    expect(state.pendingTools[0].request.callId).toBe("call");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", toolCallId: "source" });
    state = apply(state, "user.steer", { text: "preserve pending work" });
    expect(state.phase).toBe("ready_model");
    expect(state.pendingTools).toEqual([]);
    expect(() => apply(apply(initial(), "model.started"), "model.completed", {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "duplicate", name: "read" }, { id: "duplicate", name: "read" }]
    })).toThrow("duplicate tool call id");

    const inFlight = (): KernelState => apply(initial(), "model.started");
    const length = apply(inFlight(), "model.completed", { message: { role: "assistant", content: "partial" }, toolCalls: [], finishReason: "length" });
    expect(length.phase).toBe("ready_model");
    const filtered = apply(inFlight(), "model.completed", { message: { role: "assistant", content: "" }, toolCalls: [], finishReason: "content_filter" });
    expect(filtered.proposedOutcome).toMatchObject({ kind: "fatal", code: "content_filter" });
    let incomplete = apply(inFlight(), "model.completed", { message: { role: "assistant", content: "answer" }, toolCalls: [], finishReason: "stop" });
    expect(incomplete.phase).toBe("ready_model");
    expect(incomplete.messages.at(-1)).toMatchObject({ role: "developer" });
    incomplete = apply(inFlight(), "model.completed", { message: { role: "invalid" }, text: "fallback", toolCalls: [] });
    expect(incomplete.phase).toBe("ready_model");
    incomplete = apply(inFlight(), "model.completed", { message: null, toolCalls: [] });
    expect(incomplete.phase).toBe("ready_model");

    const modelFailure = apply(inFlight(), "model.failed", { message: "network" });
    expect(modelFailure.proposedOutcome).toMatchObject({ kind: "recoverable_failure", code: "model_error" });
    expect(apply(inFlight(), "model.failed", { code: "overload", message: "retry" }).proposedOutcome).toMatchObject({ code: "overload" });

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
    state = apply(state, "tool.requested", { callId: "call", name: "read" });
    state = apply(state, "tool.requested", { callId: "call", name: "read" });
    expect(state.pendingTools).toHaveLength(1);

    state = apply(state, "tool.approval_requested", { callId: "call" });
    expect(state.phase).toBe("needs_input");
    state = apply(state, "tool.approval_resolved", { callId: "call", decision: "allow" });
    expect(state.pendingTools[0].approval).toBe("allowed");
    state = apply(state, "tool.started", { callId: "call" });
    expect(state.phase).toBe("tool_in_flight");
    state = apply(state, "diagnostic", { kind: "recovery.reset_tool", callId: "call", approval: "pending" });
    expect(state).toMatchObject({ phase: "needs_input", pendingTools: [{ started: false, approval: "pending" }] });
    state = apply(state, "tool.approval_resolved", { callId: "call", decision: "always_allow" });
    state = apply(state, "tool.completed", {
      callId: "call", ok: true, output: "contents", observedEffects: ["filesystem.read"], artifacts: [], diagnostics: [],
      startedAt: "start", completedAt: "end"
    });
    expect(state).toMatchObject({ phase: "ready_model", receipts: [{ callId: "call", ok: true }] });
    expect(state.evidence).toHaveLength(1);
    expect(state.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call", content: "contents" });

    let completion = apply(initial(), "tool.requested", { callId: "complete", name: "complete_task", arguments: null });
    completion = apply(completion, "tool.completed", {
      callId: "complete", ok: true, output: JSON.stringify({ summary: "evidence-backed result" }),
      observedEffects: ["outcome.propose"], artifacts: ["artifact"], diagnostics: ["checked"], startedAt: "start", completedAt: "end"
    });
    expect(completion).toMatchObject({ phase: "outcome_pending", proposedOutcome: { kind: "completed", message: "evidence-backed result" } });

    let denied = apply(initial(), "tool.requested", { callId: "deny", name: "write", arguments: null });
    denied = apply(denied, "tool.approval_resolved", { callId: "deny", decision: "deny" });
    expect(denied.pendingTools[0].approval).toBe("denied");
    denied = apply(denied, "tool.failed", { callId: "deny", ok: false, output: 42 });
    expect(denied.evidence).toHaveLength(0);
    expect(denied.messages.at(-1)?.content).toBe("");

    const invalidReceipt = apply(initial(), "tool.failed", null);
    expect(invalidReceipt.receipts).toEqual([]);
    const suspended = apply(initial(), "run.suspended", { requestId: "approval", message: "choose" });
    expect(suspended.outcome).toEqual({ kind: "needs_input", requestId: "approval", message: "choose" });
    expect(apply(initial(), "diagnostic", { kind: "recovery.retry_model" }).phase).toBe("ready_model");
    expect(apply(initial(), "diagnostic", { kind: "other" }).phase).toBe("idle");
    expect(apply(initial(), "context.compacted", []).phase).toBe("idle");
  });

  it("rehydrates deterministically and checks state invariants", () => {
    const first = envelope(initial(), "user.message", { text: "hello" });
    const second = { ...envelope({ ...initial(), lastSeq: 1 }, "model.started"), seq: 2 };
    const restored = rehydrate(initial(), [first, second]);
    expect(restored).toMatchObject({ phase: "model_in_flight", lastSeq: 2, revision: 2 });
    expect(() => assertKernelInvariants({
      ...initial(), phase: "tool_pending",
      pendingTools: [
        { request: { callId: "same", name: "a", arguments: null }, approval: "allowed", started: false },
        { request: { callId: "same", name: "b", arguments: null }, approval: "allowed", started: false }
      ]
    })).toThrow("Duplicate pending");
    expect(() => assertKernelInvariants({ ...initial(), phase: "terminal" })).toThrow("requires an outcome");
    expect(() => assertKernelInvariants({ ...initial(), outcome: { kind: "fatal", code: "x", message: "x" } })).toThrow("Non-terminal");
    expect(() => assertKernelInvariants({ ...initial(), phase: "needs_input", outcome: { kind: "needs_input", requestId: "x", message: "x" } })).not.toThrow();
    expect(() => assertKernelInvariants({ ...initial(), phase: "terminal", outcome: { kind: "completed", message: "x", evidence: [] } })).not.toThrow();
  });
});
