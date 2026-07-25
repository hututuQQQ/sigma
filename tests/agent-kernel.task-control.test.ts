import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  KERNEL_STATE_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  createKernelState,
  evolve,
  isKernelState,
  type KernelState
} from "../packages/agent-kernel/src/index.js";

const NOW = "2026-07-23T00:00:00.000Z";

function initial(): KernelState {
  return createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-07-23T01:00:00.000Z"
  });
}

function apply(state: KernelState, type: AgentEventType, payload: JsonValue): KernelState {
  const event: AgentEventEnvelope = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: state.lastSeq + 1,
    eventId: `event-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: NOW,
    type,
    authority: "runtime",
    payload
  };
  return evolve(state, event);
}

describe("model-led kernel state", () => {
  it("has no semantic task-control state and rejects its reintroduction", () => {
    const state = initial();
    expect(state.schemaVersion).toBe(KERNEL_STATE_VERSION);
    expect(state).not.toHaveProperty("taskControl");
    expect(isKernelState(state)).toBe(true);
    expect(isKernelState({ ...state, taskControl: {} })).toBe(false);
    assertKernelInvariants(state);
  });

  it("proposes a natural-stop answer directly and treats a question as ordinary text", () => {
    let state = apply(initial(), "user.message", { text: "Inspect and report." });
    state = apply(state, "model.started", { turnId: 1, effectRevision: state.revision });
    state = apply(state, "model.completed", {
      turnId: 1,
      effectRevision: state.activeModelTurn!.effectRevision,
      message: { role: "assistant", content: "Should this be shipped?" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(state).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: { kind: "completed", message: "Should this be shipped?" }
    });
    expect(state.pendingTools).toEqual([]);
    assertKernelInvariants(state);
  });

  it("keeps an empty natural stop typed without inventing a hidden completion call", () => {
    let state = apply(initial(), "user.message", { text: "Finish." });
    state = apply(state, "model.started", { turnId: 1, effectRevision: state.revision });
    state = apply(state, "model.completed", {
      turnId: 1,
      effectRevision: state.activeModelTurn!.effectRevision,
      message: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(state.proposedOutcome).toMatchObject({
      kind: "recoverable_failure",
      code: "empty_assistant_response"
    });
    expect(state.toolCallIds).toEqual([]);
    assertKernelInvariants(state);
  });
});
