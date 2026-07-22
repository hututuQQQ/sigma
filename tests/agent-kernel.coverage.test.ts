import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  createBudgetLedger,
  SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  acceptMutationFrontier,
  assertKernelInvariants,
  createKernelState,
  completionEvidenceObligation,
  createTaskControlState,
  decide,
  emptyMutationFrontier,
  evolve,
  frontierAfterCheckpoint,
  frontierAfterEvidence,
  isTaskControlStateV1,
  InvalidBudgetTransitionError,
  isKernelState,
  isStaleEffect,
  isTerminal,
  netChangedPaths,
  protectCompletionCandidate,
  rehydrate,
  type KernelState
} from "../packages/agent-kernel/src/index.js";

function diagnosticEvidence(id = "evidence"): EvidenceRecord {
  return {
    evidenceId: id,
    sessionId: "session",
    runId: "run",
    kind: "diagnostic",
    status: "passed",
    createdAt: "2026-01-01T00:00:00.000Z",
    producer: { authority: "runtime" },
    summary: "checked",
    data: { source: "test", diagnostic: { ok: true } }
  };
}

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
    schemaVersion: EVENT_SCHEMA_VERSION,
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

function proposeToolBatch(
  state: KernelState,
  turnId: number,
  calls: Array<{ id: string; name: string; arguments: JsonValue }>
): KernelState {
  return settleModel(startModel(state, turnId), "model.completed", {
    message: { role: "assistant", content: "", toolCalls: calls },
    toolCalls: calls,
    finishReason: "tool_calls"
  });
}

function completedReceipt(
  output: string,
  timestamp: string,
  workspaceDelta?: { added: string[]; modified: string[]; deleted: string[] }
): Record<string, JsonValue> {
  return {
    ok: true,
    output,
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    ...(workspaceDelta ? { workspaceDelta } : {}),
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: timestamp,
    completedAt: timestamp
  };
}

describe("agent-kernel exhaustive protocol behavior", () => {
  it("durably records every call in a mixed terminal batch for runtime policy receipts", () => {
    let state = apply(initial(), "user.message", { text: "inspect or ask" });
    const mixed = (turn: number) => [
      { id: `ask-${turn}`, name: "request_user_input", arguments: { message: "Which path?" } },
      { id: `read-${turn}`, name: "read", arguments: { path: "seed.txt" } }
    ];
    state = proposeToolBatch(state, 1, mixed(1));
    expect(state).toMatchObject({ phase: "tool_pending" });
    expect(state.pendingTools.map((item) => item.request.callId)).toEqual(["ask-1", "read-1"]);
    expect(state.receipts).toEqual([]);
  });

  it("allows one completion alongside ordinary work outside a repair turn", () => {
    let state = apply(initial(), "user.message", { text: "write the result and finish" });
    state = proposeToolBatch(state, 1, [
      { id: "write-1", name: "write", arguments: { path: "result.txt", content: "done" } },
      { id: "complete-1", name: "runtime_finalize", arguments: { summary: "done" } }
    ]);
    expect(state).toMatchObject({ phase: "tool_pending" });
    expect(state.pendingTools.map((item) => item.request.callId)).toEqual(["write-1", "complete-1"]);
  });

  it("retains the active obligation while recording a mixed repair batch", () => {
    let state = apply(initial(), "user.message", { text: "finish cleanly" });
    state = {
      ...state,
      taskControl: completionEvidenceObligation(state.taskControl, state.revision, "acquire", 0)
    };
    state = proposeToolBatch(state, 1, [
      { id: "read-1", name: "read", arguments: { path: "seed.txt" } },
      { id: "complete-1", name: "runtime_finalize", arguments: { summary: "done" } }
    ]);
    expect(state.pendingTools.map((item) => item.request.callId)).toEqual(["read-1", "complete-1"]);
    expect(state.taskControl.obligation).toMatchObject({ kind: "completion_evidence", stage: "acquire" });
  });

  it("returns recoverable task-state failures from terminal repair to normal tools", () => {
    let state = apply(initial(), "user.message", { text: "finish after the process exits" });
    state = {
      ...state,
      taskControl: completionEvidenceObligation(state.taskControl, state.revision, "terminal", 1),
      evidence: [diagnosticEvidence("current-run-evidence")]
    };
    state = proposeToolBatch(state, 1, [{
      id: "complete-while-active", name: "runtime_finalize", arguments: { summary: "done" }
    }]);
    const failed = {
      ...completedReceipt("Background processes remain active.", "2026-01-01T00:00:01.000Z"),
      ok: false,
      outcome: {
        status: "failed", output: "Background processes remain active.", diagnosticCodes: ["active_processes"]
      },
      diagnostics: ["active_processes"]
    };
    state = toolEvent(state, "tool.failed", "complete-while-active", failed);
    expect(state).toMatchObject({
      phase: "ready_model",
      taskControl: {
        obligation: { kind: "completion_evidence", stage: "terminal" },
        policyCorrection: { attempts: 1 }
      }
    });
    expect(state.proposedOutcome).toBeUndefined();
    expect(state.receipts.at(-1)?.diagnostics).toEqual(["active_processes"]);
  });

  it("converts an evidence-backed ordinary text stop into a completion intent", () => {
    let state = apply(initial(), "user.message", { text: "inspect the current state" });
    state = apply(state, "evidence.recorded", diagnosticEvidence("answer-evidence"));
    state = settleModel(startModel(state), "model.completed", {
      message: { role: "assistant", content: "Which target should I change?" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(state).toMatchObject({
      phase: "tool_pending",
      pendingTools: [{ request: { name: "runtime_finalize", arguments: {
        summary: "Which target should I change?"
      } } }]
    });
    const callId = state.pendingTools[0]!.request.callId;
    state = toolEvent(state, "tool.completed", callId, {
      ok: true,
      output: JSON.stringify({ summary: "Which target should I change?" }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: "start",
      completedAt: "end"
    });
    expect(state).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: {
        kind: "completed",
        message: "Which target should I change?"
      }
    });
    expect(() => assertKernelInvariants(state)).not.toThrow();

    const outcomeRevision = state.revision;
    state = apply(state, "run.completed", {
      message: "Which target should I change?",
      outcomeRevision
    });
    expect(state).toMatchObject({
      phase: "terminal",
      outcome: {
        kind: "completed",
        message: "Which target should I change?"
      }
    });
    expect(state.taskControl.completionCandidate?.answer).toBe("Which target should I change?");
    expect(() => assertKernelInvariants(state)).not.toThrow();
  });

  it("keeps direct original-turn input requests valid even when evidence already exists", () => {
    let state = apply(initial(), "user.message", { text: "change the selected target" });
    state = apply(state, "evidence.recorded", diagnosticEvidence("preexisting-evidence"));
    state = proposeToolBatch(state, 1, [{
      id: "need-target",
      name: "request_user_input",
      arguments: { message: "Which target should I change?" }
    }]);
    state = toolEvent(state, "tool.completed", "need-target", {
      ok: true,
      output: JSON.stringify({ message: "Which target should I change?" }),
      observedEffects: ["outcome.request_input"],
      artifacts: [],
      diagnostics: [],
      startedAt: "start",
      completedAt: "end"
    });
    expect(state).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: {
        kind: "needs_input",
        requestId: "need-target",
        message: "Which target should I change?"
      }
    });
  });

  it("returns ordinary tools after a real completion blocker", () => {
    let state = apply(initial(), "user.message", { text: "finish after settling blockers" });
    state = apply(state, "evidence.recorded", diagnosticEvidence("protected-blocker-evidence"));
    state = settleModel(startModel(state), "model.completed", {
      message: { role: "assistant", content: "The inspected result is stable." },
      toolCalls: [],
      finishReason: "stop"
    });
    const blockedCallId = state.pendingTools[0]!.request.callId;
    state = toolEvent(state, "tool.failed", blockedCallId, {
      ok: false,
      output: "Background processes remain active.",
      observedEffects: [],
      artifacts: [],
      diagnostics: ["active_processes"],
      startedAt: "start",
      completedAt: "end"
    });
    expect(state).toMatchObject({
      phase: "ready_model"
    });
    expect(() => assertKernelInvariants(state)).not.toThrow();

    let requestedInput = proposeToolBatch(state, 3, [{
      id: "blocked-input-request",
      name: "request_user_input",
      arguments: { message: "Should I stop the process?" }
    }]);
    expect(requestedInput).toMatchObject({
      phase: "tool_pending",
      pendingTools: [{ request: { callId: "blocked-input-request", name: "request_user_input" } }]
    });
    requestedInput = toolEvent(requestedInput, "tool.completed", "blocked-input-request", {
      ok: true,
      output: JSON.stringify({ message: "Should I stop the process?" }),
      observedEffects: ["outcome.request_input"],
      artifacts: [],
      diagnostics: [],
      startedAt: "start",
      completedAt: "end"
    });
    expect(requestedInput.proposedOutcome).toMatchObject({
      kind: "needs_input",
      requestId: "blocked-input-request",
      message: "Should I stop the process?"
    });
    expect(() => assertKernelInvariants(requestedInput)).not.toThrow();

    const recoveryWork = proposeToolBatch(state, 3, [{
      id: "poll-blocker",
      name: "poll_process",
      arguments: { processId: "process" }
    }]);
    expect(recoveryWork).toMatchObject({
      phase: "tool_pending"
    });
  });

  it("counts duplicate content as no progress without terminating before the seven-batch bound", () => {
    let state = apply(initial(), "user.message", { text: "inspect repeatedly" });
    for (const index of [1, 2]) {
      const callId = `same-${index}`;
      state = proposeToolBatch(state, index, [{ id: callId, name: "read", arguments: { path: "seed.txt" } }]);
      state = toolEvent(state, "tool.completed", callId, completedReceipt(
        "stable result",
        `2026-01-01T00:00:0${index}.000Z`
      ));
    }
    expect(state.taskControl.episode.noProgressBatches).toBe(1);
    state = proposeToolBatch(state, 3, [{ id: "same-3", name: "read", arguments: { path: "seed.txt" } }]);
    expect(state.pendingTools).toHaveLength(1);
    expect(state.proposedOutcome).toBeUndefined();
  });

  it("hashes large repeated outputs without weakening repeated-action convergence", () => {
    const largeOutput = "stable payload ".repeat(100_000);
    let state = apply(initial(), "user.message", { text: "inspect a large stable result" });
    for (const index of [1, 2]) {
      const callId = `large-${index}`;
      state = proposeToolBatch(state, index, [{ id: callId, name: "read", arguments: { path: "large.txt" } }]);
      state = toolEvent(state, "tool.completed", callId, completedReceipt(
        largeOutput,
        `2026-01-01T00:00:0${index}.000Z`
      ));
    }
    state = proposeToolBatch(state, 3, [{ id: "large-3", name: "read", arguments: { path: "large.txt" } }]);

    expect(state.pendingTools).toHaveLength(1);
    expect(state.proposedOutcome).toBeUndefined();
  });

  it("resets the completed-outcome streak when another batch intervenes", () => {
    let state = apply(initial(), "user.message", { text: "inspect related paths" });
    for (const index of [1, 2]) {
      const callId = `first-path-${index}`;
      state = proposeToolBatch(state, index, [{ id: callId, name: "read", arguments: { path: "a.txt" } }]);
      state = toolEvent(state, "tool.completed", callId, completedReceipt("A", `2026-01-01T00:00:0${index}.000Z`));
    }
    state = proposeToolBatch(state, 3, [{ id: "other-path", name: "read", arguments: { path: "b.txt" } }]);
    state = toolEvent(state, "tool.completed", "other-path", completedReceipt("B", "2026-01-01T00:00:03.000Z"));
    expect(state.taskControl.episode.noProgressBatches).toBe(0);
    state = proposeToolBatch(state, 4, [{ id: "first-path-again", name: "read", arguments: { path: "a.txt" } }]);
    expect(state.phase).toBe("tool_pending");
    expect(state.proposedOutcome).toBeUndefined();
  });

  it.each([
    ["receipt output", completedReceipt("first", "2026-01-01T00:00:01.000Z"),
      completedReceipt("second", "2026-01-01T00:00:02.000Z")],
    ["workspace delta", completedReceipt("stable", "2026-01-01T00:00:01.000Z", {
      added: ["first.txt"], modified: [], deleted: []
    }), completedReceipt("stable", "2026-01-01T00:00:02.000Z", {
      added: [], modified: ["second.txt"], deleted: []
    })]
  ])("allows a third identical call when the completed %s changes", (_label, first, second) => {
    let state = apply(initial(), "user.message", { text: "observe changing results" });
    state = proposeToolBatch(state, 1, [{ id: "changing-1", name: "read", arguments: { path: "seed.txt" } }]);
    state = toolEvent(state, "tool.completed", "changing-1", first);
    state = proposeToolBatch(state, 2, [{ id: "changing-2", name: "read", arguments: { path: "seed.txt" } }]);
    state = toolEvent(state, "tool.completed", "changing-2", second);
    expect(state.taskControl.episode.noProgressBatches).toBe(0);
    state = proposeToolBatch(state, 3, [{ id: "changing-3", name: "read", arguments: { path: "seed.txt" } }]);
    expect(state.phase).toBe("tool_pending");
    expect(state.pendingTools).toHaveLength(1);
    expect(state.proposedOutcome).toBeUndefined();
  });

  it("makes multi-tool completed outcome signatures independent of call and receipt order", () => {
    const calls = (batch: number, reverse = false) => {
      const values = [
        { id: `batch-${batch}-a`, name: "read", arguments: { path: "a.txt" } },
        { id: `batch-${batch}-b`, name: "read", arguments: { path: "b.txt" } }
      ];
      return reverse ? values.reverse() : values;
    };
    let state = apply(initial(), "user.message", { text: "inspect both paths" });
    state = proposeToolBatch(state, 1, calls(1));
    state = toolEvent(state, "tool.completed", "batch-1-a", completedReceipt("A", "2026-01-01T00:00:01.000Z"));
    state = toolEvent(state, "tool.completed", "batch-1-b", completedReceipt("B", "2026-01-01T00:00:02.000Z"));
    state = proposeToolBatch(state, 2, calls(2));
    state = toolEvent(state, "tool.completed", "batch-2-b", completedReceipt("B", "2026-01-01T00:00:03.000Z"));
    state = toolEvent(state, "tool.completed", "batch-2-a", completedReceipt("A", "2026-01-01T00:00:04.000Z"));
    expect(state.taskControl.episode.noProgressBatches).toBe(1);
    state = proposeToolBatch(state, 3, calls(3, true));
    expect(state.pendingTools).toHaveLength(2);
    expect(state.proposedOutcome).toBeUndefined();
  });

  it("rejects legacy repetition authorities in new snapshots", () => {
    expect(isKernelState({
      ...initial(),
      lastToolBatchSignature: "legacy-call-signature",
      repeatedToolBatchCount: 2
    })).toBe(false);
    expect(isKernelState({ ...initial(), lastToolBatchOutcomeSignature: 42 })).toBe(false);
  });

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
    expect(state.activeModelSemanticDelta).toBe(false);
    state = apply(state, "model.delta", { turnId: 1, delta: "durable" });
    expect(state.activeModelSemanticDelta).toBe(true);
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
    expect(state.activeModelSemanticDelta).toBeUndefined();
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
    const duplicate = settleModel(startModel(apply(initial(), "user.message", { text: "duplicate" })), "model.completed", {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "duplicate", name: "read" }, { id: "duplicate", name: "read" }]
    });
    expect(duplicate).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: { kind: "recoverable_failure", code: "protocol_error" }
    });

    const inFlight = (): KernelState => startModel(apply(initial(), "user.message", { text: "request" }));
    const length = settleModel(inFlight(), "model.completed", { message: { role: "assistant", content: "partial" }, toolCalls: [], finishReason: "length" });
    expect(length.phase).toBe("ready_model");
    const secondLength = settleModel(startModel(length, 2), "model.completed", {
      message: { role: "assistant", content: "still partial" }, toolCalls: [], finishReason: "length"
    });
    const exhaustedLength = settleModel(startModel(secondLength, 3), "model.completed", {
      message: { role: "assistant", content: "again partial" }, toolCalls: [], finishReason: "length"
    });
    expect(exhaustedLength.proposedOutcome).toMatchObject({
      kind: "recoverable_failure", code: "model_output_limit"
    });
    const filtered = settleModel(inFlight(), "model.completed", { message: { role: "assistant", content: "" }, toolCalls: [], finishReason: "content_filter" });
    expect(filtered.proposedOutcome).toMatchObject({ kind: "fatal", code: "content_filter" });
    const conversational = settleModel(inFlight(), "model.completed", { message: { role: "assistant", content: "answer" }, toolCalls: [], finishReason: "stop" });
    expect(conversational).toMatchObject({
      phase: "tool_pending",
      proposedOutcome: undefined
    });
    const receipt = {
      callId: "progress", ok: true, output: "inspected", observedEffects: ["filesystem.read" as const],
      artifacts: [], diagnostics: [], startedAt: "start", completedAt: "end"
    };
    const incomplete = settleModel({ ...inFlight(), receipts: [receipt] }, "model.completed", {
      message: { role: "assistant", content: "premature answer" }, toolCalls: [], finishReason: "stop"
    });
    expect(incomplete).toMatchObject({
      phase: "tool_pending",
      pendingTools: [{ request: { name: "runtime_finalize", arguments: { summary: "premature answer" } } }]
    });
    const failedEvidence = settleModel({
      ...inFlight(),
      evidence: [{ ...diagnosticEvidence("failed-evidence"), status: "failed" }]
    }, "model.completed", {
      message: { role: "assistant", content: "failed evidence is insufficient" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(failedEvidence).toMatchObject({ phase: "tool_pending", pendingTools: [{ request: { name: "runtime_finalize" } }] });
    const provenanceOnly = settleModel({
      ...inFlight(),
      evidence: [{
        ...diagnosticEvidence("subject-attestation"),
        data: { source: SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1, diagnostic: { productDigest: "opaque" } }
      }]
    }, "model.completed", {
      message: { role: "assistant", content: "attestation does not answer the task" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(provenanceOnly).toMatchObject({ phase: "tool_pending", pendingTools: [{ request: { name: "runtime_finalize" } }] });
    const evidenceBacked = settleModel({
      ...inFlight(),
      evidence: [diagnosticEvidence("current-run-evidence")]
    }, "model.completed", {
      message: { role: "assistant", content: "evidence-backed answer" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(evidenceBacked).toMatchObject({
      phase: "tool_pending",
      pendingTools: [{ request: { name: "runtime_finalize", arguments: { summary: "evidence-backed answer" } } }]
    });
    const protocolError = settleModel(inFlight(), "model.completed", {
      message: { role: "assistant", content: "invalid boundary" },
      toolCalls: [],
      finishReason: "protocol_error"
    });
    expect(protocolError.proposedOutcome).toMatchObject({
      kind: "recoverable_failure",
      code: "model_protocol_error"
    });
    const invalidMessage = settleModel(inFlight(), "model.completed", { message: { role: "invalid" }, text: "fallback", toolCalls: [] });
    expect(invalidMessage).toMatchObject({
      phase: "ready_model",
      taskControl: { obligation: { kind: "terminal_resolution", failureCode: "empty_visible_response" } }
    });
    const invalidTwice = settleModel(startModel(invalidMessage, 2), "model.completed", {
      message: { role: "invalid" }, toolCalls: []
    });
    expect(invalidTwice.proposedOutcome).toMatchObject({ kind: "recoverable_failure", code: "model_no_action" });
    const missingMessage = settleModel(inFlight(), "model.completed", { message: null, toolCalls: [] });
    expect(missingMessage.taskControl.obligation).toMatchObject({ failureCode: "empty_visible_response" });

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
    expect(apply(initial(), "run.completed", { message: "forged", evidence: [], outcomeRevision: 0 }).phase).toBe("idle");

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
      evidence: [diagnosticEvidence("read-evidence")],
      startedAt: "start", completedAt: "end"
    });
    expect(state).toMatchObject({ phase: "ready_model", receipts: [{ callId: "call", ok: true }] });
    expect(state.evidence).toHaveLength(0);
    expect(state.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call" });
    expect(state.messages.at(-1)?.content).toBe("Successful tool receipt ID: call\ncontents");

    const reusedCallId = settleModel(startModel(state, 2), "model.completed", {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "call", name: "write", arguments: { path: "different.txt", content: "different" } }],
      finishReason: "tool_calls"
    });
    expect(reusedCallId).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: { kind: "recoverable_failure", code: "protocol_error" },
      pendingTools: []
    });

    let malformedInputRequest = withPendingTool("input-malformed", "request_user_input");
    malformedInputRequest = toolEvent(malformedInputRequest, "tool.completed", "input-malformed", {
      ok: true, output: "{", observedEffects: ["outcome.request_input"], artifacts: [], diagnostics: [],
      startedAt: "start", completedAt: "end"
    });
    expect(malformedInputRequest).toMatchObject({ phase: "ready_model", proposedOutcome: undefined });

    let malformedCompletion = withPendingTool("completion-malformed", "runtime_finalize");
    malformedCompletion = toolEvent(malformedCompletion, "tool.completed", "completion-malformed", {
      ok: true, output: "{", observedEffects: ["outcome.propose"], artifacts: [], diagnostics: [],
      startedAt: "start", completedAt: "end"
    });
    expect(malformedCompletion).toMatchObject({ phase: "ready_model", proposedOutcome: undefined });

    const arrayArguments = settleModel(startModel(apply(initial(), "user.message", { text: "array args" })), "model.completed", {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "array-args", name: "read", arguments: [1, { nested: ["value"] }] }],
      finishReason: "tool_calls"
    });
    expect(arrayArguments).toMatchObject({ phase: "tool_pending", pendingTools: [{ request: { callId: "array-args" } }] });

    let completion = withPendingTool("complete", "runtime_finalize");
    completion = toolEvent(completion, "tool.completed", "complete", {
      ok: true, output: JSON.stringify({ summary: "evidence-backed result" }),
      observedEffects: ["outcome.propose"], artifacts: ["artifact"], diagnostics: ["checked"], startedAt: "start", completedAt: "end"
    });
    expect(completion).toMatchObject({ phase: "outcome_pending", proposedOutcome: { kind: "completed", message: "evidence-backed result" } });

    let bodyCompletion = withPendingTool("complete-with-body", "runtime_finalize");
    bodyCompletion = {
      ...bodyCompletion,
      messages: bodyCompletion.messages.map((message, index) => index === bodyCompletion.messages.length - 1
        ? { ...message, content: "Detailed same-turn answer." } : message)
    };
    bodyCompletion = toolEvent(bodyCompletion, "tool.completed", "complete-with-body", {
      ok: true, output: JSON.stringify({ summary: "short fallback" }),
      observedEffects: ["outcome.propose"], artifacts: [], diagnostics: [], startedAt: "start", completedAt: "end"
    });
    expect(bodyCompletion).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: {
        kind: "completed",
        message: "Detailed same-turn answer.\n\nResult: short fallback"
      }
    });

    let repairedCompletion = withPendingTool("repair-complete", "runtime_finalize");
    repairedCompletion = {
      ...repairedCompletion,
      taskControl: protectCompletionCandidate(
        repairedCompletion.taskControl,
        "Detailed final answer."
      ),
      evidence: [diagnosticEvidence("repair-evidence")],
      messages: [...repairedCompletion.messages, {
        role: "assistant",
        content: "Repair-turn text must not replace the protected answer."
      }]
    };
    repairedCompletion = toolEvent(repairedCompletion, "tool.completed", "repair-complete", {
      ok: true, output: JSON.stringify({ summary: "short summary" }),
      observedEffects: ["outcome.propose"], artifacts: [], diagnostics: [],
      startedAt: "start", completedAt: "end"
    });
    expect(repairedCompletion).toMatchObject({
      proposedOutcome: {
        kind: "completed",
        message: "Detailed final answer.\n\nResult: short summary"
      }
    });
    const committedRevision = completion.revision;
    expect(apply(completion, "run.completed", {
      message: "committed", outcomeRevision: committedRevision, evidence: [diagnosticEvidence("durable-child")]
    })).toMatchObject({
      phase: "terminal",
      outcome: { kind: "completed", message: "evidence-backed result", evidence: [] }
    });
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

    let superseded = withPendingTool("complete-race", "runtime_finalize");
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

  it("does not replay completion arguments after prerequisite evidence arrives", () => {
    let state = withPendingTool("completion-needs-validation", "runtime_finalize", {
      summary: "The requested change is complete.",
    });
    state = toolEvent(state, "tool.failed", "completion-needs-validation", {
      ok: false,
      output: "Completion requires current-run validation evidence.",
      outcome: {
        status: "failed",
        output: "Completion requires current-run validation evidence.",
        diagnosticCodes: ["validation_evidence_required"]
      },
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: ["validation_evidence_required"],
      evidence: [],
      startedAt: "start",
      completedAt: "end"
    });
    expect(state).toMatchObject({
      phase: "ready_model",
      taskControl: { obligation: {
        kind: "completion_evidence",
        stage: "acquire",
        originalCallId: "completion-needs-validation",
        evidenceCount: 0,
        attempts: 0
      } }
    });

    state = apply(state, "evidence.recorded", {
      evidenceId: "validation-ready",
      sessionId: "session",
      runId: "run",
      kind: "validation",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime" },
      summary: "Validation passed.",
      data: {
        validator: "command",
        command: "check",
        exitCode: 0,
        termination: {
          processStarted: true,
          state: "exited",
          exitCode: 0,
          signal: null,
          timedOut: false,
          idleTimedOut: false,
          cancelled: false
        },
        artifactIds: [],
        frontierRevision: 0,
        stateDigest: "0".repeat(64),
        coveredPaths: []
      }
    });

    expect(state).toMatchObject({
      phase: "ready_model",
      pendingTools: [],
      taskControl: { phase: "normal", obligation: undefined }
    });
    expect(decide(state).map((effect) => effect.type)).toEqual(["request_model"]);
    expect(() => assertKernelInvariants(state)).not.toThrow();
  });

  it("advances a user-resolved checkpoint recovery out of NeedsInput", () => {
    const suspended = apply(initial(), "run.suspended", {
      requestId: "checkpoint:checkpoint-one",
      checkpointId: "checkpoint-one",
      choices: ["restore", "keep"]
    });
    expect(suspended.phase).toBe("needs_input");

    const resolved = evolve(suspended, {
      ...envelope(suspended, "checkpoint.recovery_resolved", {
        checkpointId: "checkpoint-one",
        decision: "restore"
      }),
      authority: "user"
    });
    expect(resolved.phase).toBe("ready_model");
    expect(resolved.outcome).toBeUndefined();
    expect(resolved.proposedOutcome).toBeUndefined();
  });

  it("reduces V3 evidence, usage, plan, budget, checkpoint, and review authorities", () => {
    let state = apply(initial(), "evidence.recorded", diagnosticEvidence("direct"));
    state = apply(state, "evidence.recorded", diagnosticEvidence("direct"));
    expect(state.evidence.map((item) => item.evidenceId)).toEqual(["direct"]);
    state = apply(state, "evidence.recorded", { ...diagnosticEvidence("old-run"), runId: "old-run" });
    expect(state.evidence.map((item) => item.evidenceId)).toEqual(["direct"]);

    state = apply(state, "usage.recorded", {
      usageId: "usage-1", requestId: "request", sessionId: "session", runId: "run", role: "orchestrator",
      routeId: "route", providerId: "deepseek", modelId: "model", tokenizerId: "approx", tokenizerAccuracy: "approximate",
      providerReported: false, inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, costMicroUsd: 100, latencyMs: 20, attempt: 1, occurredAt: "2026-01-01T00:00:00.000Z"
    });
    expect(state.usage).toHaveLength(1);

    state = apply(state, "plan.updated", {
      previousRevision: 0,
      plan: {
        revision: 1,
        goal: "ship V3",
        activeNodeId: "r0",
        nodes: [{
          id: "r0", title: "protocol", dependencies: [], status: "in_progress",
          owner: { kind: "root" }, acceptanceCriteria: ["typed"], evidence: []
        }]
      }
    });
    expect(state.plan).toMatchObject({ revision: 1, activeNodeId: "r0" });
    const stalePlan = apply(state, "plan.updated", { previousRevision: 0, plan: { revision: 2, goal: "stale", nodes: [] } });
    expect(stalePlan.plan).toBe(state.plan);
    state = stalePlan;

    const ledger = createBudgetLedger();
    ledger.reserved.inputTokens = 100;
    ledger.reservations.push({
      reservationId: "reservation",
      ownerId: "model:request",
      status: "reserved",
      requested: { ...ledger.reserved },
      consumed: { ...ledger.consumed },
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    state = apply(state, "budget.reserved", { reservationId: "reservation", ledger } as unknown as JsonValue);
    expect(state.budget.reserved.inputTokens).toBe(100);

    state = apply(state, "checkpoint.created", {
      checkpointId: "checkpoint", sessionId: "session", runId: "run", status: "open",
      createdAt: "2026-01-01T00:00:00.000Z", preManifestDigest: "a".repeat(64)
    });
    expect(state.checkpointHead).toMatchObject({ checkpointId: "checkpoint", status: "open" });
    const wrongStatus = apply(state, "checkpoint.sealed", {
      checkpointId: "checkpoint", sessionId: "session", runId: "run", status: "open",
      createdAt: "2026-01-01T00:00:00.000Z", preManifestDigest: "a".repeat(64)
    });
    expect(wrongStatus.checkpointHead?.status).toBe("open");
    state = wrongStatus;

    const waiver: EvidenceRecord = {
      evidenceId: "waiver", kind: "user_waiver", status: "informational",
      sessionId: "session", runId: "run",
      createdAt: "2026-01-01T00:00:00.000Z", producer: { authority: "user" }, summary: "waived",
      data: { scope: "review", reason: "explicit" }
    };
    const runtimeWaiver = apply(state, "review.waived", waiver);
    expect(runtimeWaiver.evidence.some((item) => item.evidenceId === "waiver")).toBe(false);
    state = evolve(runtimeWaiver, { ...envelope(runtimeWaiver, "review.waived", waiver), authority: "user" });
    expect(state.evidence.some((item) => item.evidenceId === "waiver")).toBe(true);
    const secondWaiver = { ...waiver, evidenceId: "second-waiver" };
    state = evolve(state, { ...envelope(state, "review.waived", secondWaiver), authority: "user" });
    expect(state.evidence.filter((item) => item.kind === "user_waiver")).toHaveLength(1);
    expect(() => assertKernelInvariants(state)).not.toThrow();
    expect(isKernelState(state)).toBe(true);

    const terminal = apply(initial(), "run.failed", {
      kind: "recoverable_failure", code: "review_required", message: "await follow-up"
    });
    const forgedTerminalWaiver = evolve(terminal, {
      ...envelope(terminal, "review.waived", waiver), authority: "tool"
    });
    expect(forgedTerminalWaiver.evidence).toEqual([]);
    const userTerminalWaiver = evolve(forgedTerminalWaiver, {
      ...envelope(forgedTerminalWaiver, "review.waived", waiver), authority: "user"
    });
    expect(userTerminalWaiver.phase).toBe("terminal");
    expect(userTerminalWaiver.evidence).toContainEqual(waiver);
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
    expect(isKernelState({
      ...initial(),
      completionRepairAttempts: 1,
      completionRepair: { kind: "protected_completion", answer: "   " }
    })).toBe(false);
    expect(() => assertKernelInvariants({
      ...initial(), completionRepairAttempts: 1
    })).toThrow("superseded task-control authorities");
    expect(isKernelState({
      ...initial(),
      taskControl: {
        ...initial().taskControl,
        completionCandidate: { answer: "   ", digest: "a".repeat(64) }
      }
    })).toBe(false);
    expect(() => assertKernelInvariants({
      ...initial(),
      phase: "needs_input",
      toolCallIds: ["approve-read"],
      pendingTools: [{
        request: { callId: "approve-read", name: "read", arguments: null },
        modelTurn: { turnId: 1, effectRevision: 1 },
        approval: "pending",
        started: false
      }],
      outcome: { kind: "needs_input", requestId: "approve-read", message: "Approve read." }
    })).not.toThrow();
    expect(() => assertKernelInvariants({
      ...initial(), activeProcessIds: ["duplicate", "duplicate"]
    })).toThrow("Duplicate active process IDs");
  });

  it("rejects corrupt durable ledgers before a resumed run can execute", () => {
    const base = initial();
    const usage = {
      usageId: "usage", requestId: "request", sessionId: "session", runId: "run", role: "orchestrator" as const,
      routeId: "route", providerId: "deepseek", modelId: "model", tokenizerId: "approx",
      tokenizerAccuracy: "approximate" as const, providerReported: false, inputTokens: 1, outputTokens: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0, latencyMs: 1,
      attempt: 1, occurredAt: "2026-01-01T00:00:00.000Z"
    };
    const waiver = {
      evidenceId: "waiver", sessionId: "session", runId: "run", kind: "user_waiver" as const,
      status: "informational" as const, createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "user" as const }, summary: "waived", data: { scope: "review" as const, reason: "operator" }
    };
    const reservation = {
      reservationId: "reservation", ownerId: "owner", status: "reserved" as const,
      requested: { inputTokens: 1, outputTokens: 0, costMicroUsd: 0, modelTurns: 0, toolCalls: 0, children: 0 },
      consumed: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0, toolCalls: 0, children: 0 },
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const invalidStates: Array<[KernelState, string]> = [
      [{ ...base, schemaVersion: 2 } as unknown as KernelState, "schema version"],
      [{ ...base, plan: { revision: 0, goal: "", activeNodeId: "missing", nodes: [] } }, "plan graph"],
      [{ ...base, budget: { ...base.budget, consumed: { inputTokens: -1 } } as never }, "budget ledger"],
      [{ ...base, checkpointHead: { checkpointId: "bad" } as never }, "checkpoint head"],
      [{ ...base, checkpointHead: {
        checkpointId: "checkpoint", sessionId: "other", runId: "run", status: "open",
        createdAt: "2026-01-01T00:00:00.000Z", preManifestDigest: "digest"
      } }, "checkpoint head"],
      [{ ...base, evidence: [{} as EvidenceRecord] }, "evidence ledger"],
      [{ ...base, mutationEvidence: [{} as EvidenceRecord] }, "mutation evidence ledger"],
      [{ ...base, mutationEvidence: [{ ...waiver, sessionId: "other" }] }, "mutation evidence must belong"],
      [{ ...base, mutationEvidence: [waiver, { ...waiver }] }, "Duplicate kernel mutation evidence"],
      [{ ...base, evidence: [{ ...diagnosticEvidence(), sessionId: "other" }] }, "active session"],
      [{ ...base, evidence: [waiver, { ...waiver, evidenceId: "waiver-two" }] }, "at most one"],
      [{ ...base, evidence: [diagnosticEvidence(), diagnosticEvidence()] }, "Duplicate kernel evidence"],
      [{ ...base, usage: [{} as never] }, "usage ledger"],
      [{ ...base, usage: [usage, { ...usage }] }, "Duplicate kernel usage"],
      [{ ...base, budget: { ...base.budget, reservations: [reservation, { ...reservation }] } }, "Duplicate budget"],
      [{ ...base, budget: {
        ...base.budget,
        reserved: { ...base.budget.reserved, inputTokens: 1 }
      } }, "does not match its active reservations"],
      [{ ...base, semanticProgress: null } as unknown as KernelState, "superseded task-control authorities"],
      [{ ...base, semanticFailureCluster: {} } as unknown as KernelState, "superseded task-control authorities"],
      [{ ...base, taskControl: {} } as unknown as KernelState, "task-control state is invalid"],
      [{
        ...base,
        taskControl: {
          ...base.taskControl,
          semanticFacts: { entries: [{ kind: "content", digest: "a".repeat(64), revision: 1 }] }
        }
      }, "exceed the current kernel revision"],
      [{ ...base, toolCallIds: ["same", "same"] }, "Duplicate run tool"],
      [{ ...base, phase: "tool_pending", pendingTools: [{
        request: { callId: "missing", name: "read", arguments: null },
        modelTurn: { turnId: 1, effectRevision: 1 }, approval: "allowed", started: false
      }] }, "run tool-call ledger"],
      [{ ...base, phase: "tool_pending", toolCallIds: ["invalid-revision"], pendingTools: [{
        request: { callId: "invalid-revision", name: "read", arguments: null },
        modelTurn: { turnId: 1, effectRevision: Number.NaN }, approval: "allowed", started: false
      }] }, "valid originating model turn"],
      [{ ...base, activeModelSemanticDelta: true }, "durable model semantic delta"]
    ];
    for (const [state, message] of invalidStates) {
      expect(() => assertKernelInvariants(state), message).toThrow(message);
    }
  });

  it("enforces authority and identity on every durable reducer family", () => {
    let state = initial();
    const toolEvidence = {
      ...diagnosticEvidence("tool-evidence"),
      producer: { authority: "tool" as const }
    };
    state = evolve(state, { ...envelope(state, "evidence.recorded", toolEvidence), authority: "tool" });
    expect(state.evidence.map((item) => item.evidenceId)).toEqual(["tool-evidence"]);
    const forbiddenReview = {
      ...toolEvidence, evidenceId: "forged-review", kind: "review" as const,
      data: { reviewerId: "tool", verdict: "approved" as const, findings: [], frontierRevision: 0, stateDigest: "0".repeat(64) }
    };
    expect(evolve(state, { ...envelope(state, "evidence.recorded", forbiddenReview), authority: "tool" }).evidence)
      .toHaveLength(1);
    const review: EvidenceRecord = {
      evidenceId: "review", sessionId: "session", runId: "run", kind: "review", status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z", producer: { authority: "runtime" }, summary: "approved",
      data: { reviewerId: "reviewer", verdict: "approved", findings: [], frontierRevision: 0, stateDigest: "0".repeat(64) }
    };
    state = apply(state, "review.completed", review);
    expect(state.evidence.map((item) => item.evidenceId)).toEqual(["tool-evidence", "review"]);
    expect(apply(state, "evidence.recorded", { ...review, evidenceId: "runtime-forgery" }).evidence).toHaveLength(2);

    const usage = {
      usageId: "usage", requestId: "request", sessionId: "session", runId: "run", role: "orchestrator",
      routeId: "route", providerId: "deepseek", modelId: "model", tokenizerId: "approx", tokenizerAccuracy: "approximate",
      providerReported: false, inputTokens: 1, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, costMicroUsd: 0, latencyMs: 1, attempt: 1, occurredAt: "2026-01-01T00:00:00.000Z"
    } as const;
    state = apply(state, "usage.recorded", usage);
    expect(apply(state, "usage.recorded", usage).usage).toHaveLength(1);
    expect(apply(state, "usage.recorded", { ...usage, usageId: "other", sessionId: "other" }).usage).toHaveLength(1);

    expect(apply(state, "plan.updated", { previousRevision: "0", plan: null }).plan).toBe(state.plan);
    expect(() => apply(state, "budget.released", { ledger: null })).toThrow(InvalidBudgetTransitionError);
    const increased = createBudgetLedger({ ...state.budget.limits, toolCalls: state.budget.limits.toolCalls + 1 });
    expect(() => apply(state, "budget.limit_increased", {
      ledger: increased, previousLimits: state.budget.limits, increase: { toolCalls: 1 }
    })).toThrow(InvalidBudgetTransitionError);
    const previousLimits = state.budget.limits;
    state = evolve(state, {
      ...envelope(state, "budget.limit_increased", {
        ledger: increased, previousLimits, increase: { toolCalls: 1 }
      }), authority: "user"
    });
    expect(state.budget.limits.toolCalls).toBe(increased.limits.toolCalls);

    const checkpointBase = {
      checkpointId: "checkpoint", sessionId: "session", runId: "run",
      createdAt: "2026-01-01T00:00:00.000Z", preManifestDigest: "a".repeat(64)
    };
    state = apply(state, "checkpoint.sealed", {
      ...checkpointBase, status: "sealed", sealedAt: "2026-01-01T00:00:00.000Z", postManifestDigest: "b".repeat(64)
    });
    expect(state.checkpointHead?.status).toBe("sealed");
    state = apply(state, "checkpoint.restored", {
      ...checkpointBase, status: "restored", restoredAt: "2026-01-01T00:00:00.000Z", postManifestDigest: "b".repeat(64)
    });
    expect(state.checkpointHead?.status).toBe("restored");
    expect(apply(state, "checkpoint.restored", { ...checkpointBase, status: "open" }).checkpointHead?.status).toBe("restored");
    expect(apply(state, "checkpoint.restored", {
      ...checkpointBase, sessionId: "other", status: "restored", restoredAt: "2026-01-01T00:00:00.000Z"
    }).checkpointHead?.status).toBe("restored");

    expect(apply(state, "profile.resolved", { profileId: 1 }).frozenProfile).toBeUndefined();
    state = apply(state, "profile.resolved", {
      profileId: "secure", digest: "a".repeat(64), artifactId: "b".repeat(64), source: "workspace"
    });
    expect(state.frozenProfile).toMatchObject({ qualifiedName: "secure", source: "workspace" });
    expect(apply(state, "skill.loaded", { qualifiedName: "bad", digest: 1 }).frozenSkills).toHaveLength(0);
    state = apply(state, "skill.loaded", {
      qualifiedName: "workspace:review", digest: "a".repeat(64), artifactId: "b".repeat(64), source: "workspace"
    });
    expect(state.frozenSkills).toHaveLength(1);
    expect(apply(state, "customization.frozen", {
      artifactId: "bad", digest: "bad", skillCount: 0, hookCount: 0
    }).frozenCustomization).toBeUndefined();
    state = apply(state, "customization.frozen", {
      artifactId: "c".repeat(64), digest: "d".repeat(64), skillCount: 1, hookCount: 1
    });
    expect(state.frozenCustomization).toEqual({ artifactId: "c".repeat(64), digest: "d".repeat(64) });
    expect(apply(state, "skill.loaded", {
      qualifiedName: "workspace:review", digest: "d".repeat(64), artifactId: "e".repeat(64), source: "home"
    }).frozenSkills).toHaveLength(1);

    state = apply(state, "process.spawned", {
      processId: "process-1", executionId: "spawn", mode: "background"
    });
    expect(state.activeProcessIds).toEqual(["process-1"]);
    expect(apply(state, "process.spawned", {
      processId: "process-1", executionId: "spawn-again", mode: "background"
    }).activeProcessIds).toEqual(["process-1"]);
    expect(apply(state, "process.spawned", {
      processId: 1, executionId: "invalid", mode: "background"
    }).activeProcessIds).toEqual(["process-1"]);
    expect(evolve(state, {
      ...envelope(state, "process.spawned", {
        processId: "wrong-run", executionId: "spawn", mode: "background"
      }),
      runId: "other"
    }).activeProcessIds).toEqual(["process-1"]);
    expect(evolve(state, {
      ...envelope(state, "process.lost", { processId: "process-1", reason: "forged" }),
      authority: "tool"
    }).activeProcessIds).toEqual(["process-1"]);
    state = apply(state, "process.exited", { processId: "process-1", exitCode: 0 });
    expect(state.activeProcessIds).toEqual([]);
    state = apply(state, "process.spawned", {
      processId: "process-2", executionId: "spawn", mode: "pty"
    });
    state = apply(state, "process.lost", { processId: "process-2", reason: "broker ended" });
    expect(state.activeProcessIds).toEqual([]);
  });

  it("advances the frontier and invalidates old validation when a checkpoint is restored", () => {
    const open = {
      checkpointId: "checkpoint-v4", sessionId: "session", runId: "run",
      status: "open" as const, createdAt: "2026-01-01T00:00:00.000Z",
      preManifestDigest: "a".repeat(64)
    };
    let state = apply(initial(), "checkpoint.created", open);
    state = apply(state, "checkpoint.sealed", {
      ...open,
      status: "sealed",
      sealedAt: "2026-01-01T00:00:01.000Z",
      postManifestDigest: "b".repeat(64)
    });
    state = apply(state, "evidence.recorded", {
      evidenceId: "delta-v4", sessionId: "session", runId: "run",
      kind: "workspace_delta", status: "passed", createdAt: "2026-01-01T00:00:01.000Z",
      producer: { authority: "runtime" }, summary: "changed target",
      data: { checkpointId: "checkpoint-v4", delta: { added: [], modified: ["target.ts"], deleted: [] } }
    });
    const validatedRevision = state.mutationFrontier.revision;
    const validatedDigest = state.mutationFrontier.currentStateDigest;
    state = apply(state, "evidence.recorded", {
      evidenceId: "validation-v4", sessionId: "session", runId: "run",
      kind: "validation", status: "passed", createdAt: "2026-01-01T00:00:02.000Z",
      producer: { authority: "runtime" }, summary: "validated target",
      data: {
        validator: "tests", frontierRevision: validatedRevision,
        stateDigest: validatedDigest, coveredPaths: ["target.ts"]
      }
    });
    expect(state.mutationFrontier.changedPaths).toEqual(["target.ts"]);

    state = apply(state, "checkpoint.restored", {
      ...open,
      status: "restored",
      restoredAt: "2026-01-01T00:00:03.000Z",
      postManifestDigest: "b".repeat(64)
    });
    expect(state.mutationFrontier).toMatchObject({
      revision: validatedRevision + 1,
      changedPaths: [],
      sourceCheckpointIds: []
    });
    expect(state.mutationFrontier.currentStateDigest).not.toBe(validatedDigest);
    const oldValidation = state.evidence.find((item) => item.evidenceId === "validation-v4");
    expect(oldValidation).toMatchObject({ kind: "validation", data: {
      frontierRevision: validatedRevision,
      stateDigest: validatedDigest
    } });
    expect(() => assertKernelInvariants(state)).not.toThrow();
  });

  it("collapses mutation histories and includes repository-only state in the frontier", () => {
    const delta = (
      id: string,
      checkpointId: string,
      added: string[] = [],
      modified: string[] = [],
      deleted: string[] = []
    ): EvidenceRecord => ({
      evidenceId: id, sessionId: "session", runId: "run",
      kind: "workspace_delta", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime" }, summary: id,
      data: { checkpointId, delta: { added, modified, deleted } }
    });
    const history = [
      delta("delete", "cp-1", [], [], ["replaced.ts", "removed.ts"]),
      delta("add", "cp-2", ["replaced.ts", "temporary.ts"]),
      delta("modify", "cp-3", ["modified-then-added.ts"], ["replaced.ts", "temporary.ts"]),
      delta("delete-again", "cp-4", [], [], ["temporary.ts", "ordinary-delete.ts"]),
      delta("modify-first", "cp-5", [], ["modified-then-added.ts"]),
      delta("add-after-modify", "cp-6", ["modified-then-added.ts"])
    ];
    expect(netChangedPaths(history)).toEqual([
      "modified-then-added.ts", "ordinary-delete.ts", "removed.ts", "replaced.ts"
    ]);

    const repositoryDigest = "9".repeat(64);
    const withRepository = { ...emptyMutationFrontier(), repositoryStateDigest: repositoryDigest };
    const sealed = frontierAfterCheckpoint(withRepository, {
      checkpointId: "cp-1", sessionId: "session", runId: "run", status: "sealed",
      createdAt: "2026-01-01T00:00:00.000Z", sealedAt: "2026-01-01T00:00:01.000Z",
      preManifestDigest: "a".repeat(64)
    }, history);
    expect(sealed).toMatchObject({ changedPaths: [".git", "removed.ts", "replaced.ts"] });
    expect(acceptMutationFrontier(sealed)).toMatchObject({
      revision: sealed.revision,
      baselineManifestDigest: sealed.currentStateDigest,
      currentStateDigest: sealed.currentStateDigest,
      changedPaths: [], sourceCheckpointIds: []
    });
  });

  it("keeps a sealed no-op checkpoint outside the frontier and rejects inconsistent manifests", () => {
    const frontier = {
      ...emptyMutationFrontier(),
      revision: 3,
      baselineManifestDigest: "a".repeat(64),
      currentStateDigest: "b".repeat(64),
      changedPaths: ["src/existing.ts"],
      sourceCheckpointIds: ["checkpoint-existing"]
    };
    const noOp = {
      checkpointId: "checkpoint-no-op", sessionId: "session", runId: "run", status: "sealed" as const,
      createdAt: "2026-01-01T00:00:00.000Z", sealedAt: "2026-01-01T00:00:01.000Z",
      preManifestDigest: "c".repeat(64), postManifestDigest: "c".repeat(64),
      delta: { added: [], modified: [], deleted: [] }
    };

    expect(frontierAfterCheckpoint(frontier, noOp, [])).toBe(frontier);
    expect(() => frontierAfterCheckpoint(frontier, {
      ...noOp, checkpointId: "checkpoint-inconsistent", postManifestDigest: "d".repeat(64)
    }, [])).toThrow(expect.objectContaining({ code: "checkpoint_integrity_error" }));
  });

  it("rehydrates imported checkpoints and repository deltas into one current frontier", () => {
    const importedCheckpoint: EvidenceRecord = {
      evidenceId: "imported", sessionId: "session", runId: "run",
      kind: "checkpoint", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime" }, summary: "imported checkpoint",
      data: {
        checkpointId: "imported-cp", preManifestDigest: "a".repeat(64),
        sourceSessionId: "source-session"
      }
    };
    let frontier = frontierAfterEvidence(emptyMutationFrontier(), [], importedCheckpoint);
    expect(frontier).toMatchObject({
      revision: 1, baselineManifestDigest: "a".repeat(64), sourceCheckpointIds: ["imported-cp"]
    });

    frontier = frontierAfterEvidence(frontier, [], {
      evidenceId: "repo", sessionId: "session", runId: "run",
      kind: "repository_delta", status: "passed", createdAt: "2026-01-01T00:00:01.000Z",
      producer: { authority: "runtime" }, summary: "updated repository",
      data: {
        operation: "branch", beforeHead: null, afterHead: "b".repeat(40),
        beforeStateDigest: "c".repeat(64), afterStateDigest: "d".repeat(64),
        refsDigestBefore: "e".repeat(64), refsDigestAfter: "f".repeat(64),
        indexDigestBefore: "1".repeat(64), indexDigestAfter: "2".repeat(64),
        reachabilityDigestBefore: "3".repeat(64), reachabilityDigestAfter: "4".repeat(64)
      }
    });
    expect(frontier).toMatchObject({
      revision: 2, repositoryStateDigest: "d".repeat(64), changedPaths: [".git"]
    });

    const unchanged = frontierAfterEvidence(frontier, [], diagnosticEvidence("diagnostic-v4"));
    expect(unchanged).toBe(frontier);
    const workspaceEvidence: EvidenceRecord = {
      evidenceId: "workspace", sessionId: "session", runId: "run",
      kind: "workspace_delta", status: "passed", createdAt: "2026-01-01T00:00:02.000Z",
      producer: { authority: "runtime" }, summary: "workspace state",
      data: { checkpointId: "imported-cp", delta: { added: [], modified: ["file.ts"], deleted: [] } }
    };
    const workspace = frontierAfterEvidence(frontier, [workspaceEvidence], workspaceEvidence);
    expect(workspace.changedPaths).toEqual([".git", "file.ts"]);
  });

  it("validates optional persisted branches and the sole task-control schema", () => {
    const base = initial();
    expect(isKernelState({ ...base, deadlineRemainingMs: 1 })).toBe(true);
    expect(isKernelState({ ...base, lastToolBatchSignature: "read:{}" })).toBe(false);
    expect(isKernelState({
      ...base,
      lastToolBatchSignature: "read:{}",
      lastToolBatchOutcomeSignature: "a".repeat(64),
      repeatedToolBatchCount: 1
    })).toBe(false);
    expect(isKernelState({ ...base, activeModelSemanticDelta: true })).toBe(true);
    expect(isKernelState({ ...base, semanticProgress: { revision: 1 } })).toBe(false);
    expect(isKernelState({ schemaVersion: base.schemaVersion })).toBe(false);

    expect(isTaskControlStateV1(null)).toBe(false);
    expect(isTaskControlStateV1(createTaskControlState())).toBe(true);
    expect(isTaskControlStateV1({ ...createTaskControlState(), goalEpochSource: "unknown" })).toBe(false);
    expect(isTaskControlStateV1({
      ...createTaskControlState(),
      semanticFacts: {
        entries: [
          { kind: "content", digest: "a".repeat(64), revision: 0 },
          { kind: "content", digest: "a".repeat(64), revision: 0 }
        ]
      }
    })).toBe(false);
  });

  it.skip("reconciles V3 evidence-id relationships across checkpoint restoration", () => {
    const restoredDelta: EvidenceRecord = {
      evidenceId: "restored-delta", sessionId: "session", runId: "old-run",
      kind: "workspace_delta", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime" }, summary: "restored mutation",
      data: { checkpointId: "restored-checkpoint", delta: { added: [], modified: ["old.ts"], deleted: [] } }
    };
    const survivorDelta: EvidenceRecord = {
      ...restoredDelta,
      evidenceId: "survivor-delta",
      summary: "surviving mutation",
      data: { checkpointId: "survivor-checkpoint", delta: { added: [], modified: ["keep.ts"], deleted: [] } }
    };
    const sharedValidation: EvidenceRecord = {
      evidenceId: "shared-validation", sessionId: "session", runId: "old-run",
      kind: "validation", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "tool" }, summary: "validated both",
      data: { validator: "tests", workspaceDeltaEvidenceIds: ["restored-delta", "survivor-delta"] }
    };
    const sharedReview: EvidenceRecord = {
      evidenceId: "shared-review", sessionId: "session", runId: "old-run",
      kind: "review", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime" }, summary: "reviewed both",
      data: {
        reviewerId: "reviewer", verdict: "approved", findings: [],
        workspaceDeltaEvidenceIds: ["restored-delta", "survivor-delta"]
      }
    };
    const restoredOnlyValidation: EvidenceRecord = {
      ...sharedValidation,
      evidenceId: "restored-only-validation",
      summary: "validated only the restored delta",
      data: { validator: "targeted-tests", workspaceDeltaEvidenceIds: ["restored-delta"] }
    };
    const restoredOnlyReview: EvidenceRecord = {
      ...sharedReview,
      evidenceId: "restored-only-review",
      summary: "reviewed only the restored delta",
      data: {
        reviewerId: "reviewer", verdict: "approved", findings: [],
        workspaceDeltaEvidenceIds: ["restored-delta"]
      }
    };
    const targetedWaiver: EvidenceRecord = {
      evidenceId: "targeted-waiver", sessionId: "session", runId: "old-run",
      kind: "user_waiver", status: "informational", createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "user" }, summary: "waived restored checkpoint",
      data: { scope: "review", reason: "explicit", checkpointId: "restored-checkpoint" }
    };
    const unboundWaiver: EvidenceRecord = {
      ...targetedWaiver,
      evidenceId: "unbound-waiver",
      summary: "legacy unbound waiver",
      data: { scope: "review", reason: "legacy" }
    };
    const currentRunEvidence: EvidenceRecord[] = [
      { ...sharedValidation, runId: "run" },
      { ...restoredOnlyValidation, runId: "run" },
      { ...sharedReview, runId: "run" },
      { ...restoredOnlyReview, runId: "run" },
      { ...targetedWaiver, runId: "run" },
      diagnosticEvidence("unrelated-diagnostic")
    ];
    const mutationEvidence = [
      restoredDelta, survivorDelta, sharedValidation, restoredOnlyValidation,
      sharedReview, restoredOnlyReview, targetedWaiver, unboundWaiver
    ];
    const state = { ...initial(), evidence: currentRunEvidence, mutationEvidence };
    expect(() => assertKernelInvariants(state)).not.toThrow();
    const restored = {
      checkpointId: "restored-checkpoint", sessionId: "session", runId: "old-run",
      status: "restored" as const, createdAt: "2026-01-01T00:00:00.000Z",
      sealedAt: "2026-01-01T00:00:01.000Z", restoredAt: "2026-01-01T00:00:02.000Z",
      preManifestDigest: "a".repeat(64), postManifestDigest: "b".repeat(64)
    };
    const forged = evolve(state, {
      ...envelope(state, "checkpoint.restored", restored), authority: "tool"
    });
    expect(forged.checkpointHead).toBeUndefined();
    expect(forged.mutationEvidence).toEqual(state.mutationEvidence);

    const reconciled = evolve(state, envelope(state, "checkpoint.restored", restored));
    expect(reconciled.checkpointHead).toMatchObject({
      checkpointId: "restored-checkpoint", status: "restored", runId: state.runId
    });
    expect(reconciled.mutationEvidence.map((item) => item.evidenceId)).toEqual([
      "survivor-delta", "shared-validation", "shared-review", "unbound-waiver"
    ]);
    expect(reconciled.evidence.map((item) => item.evidenceId)).toEqual([
      "shared-validation", "shared-review", "unrelated-diagnostic"
    ]);
    expect(reconciled.mutationEvidence.find((item) => item.kind === "validation")?.data)
      .toMatchObject({ workspaceDeltaEvidenceIds: ["survivor-delta"] });
    expect(reconciled.mutationEvidence.find((item) => item.kind === "review")?.data)
      .toMatchObject({ workspaceDeltaEvidenceIds: ["survivor-delta"] });
    expect(reconciled.evidence.find((item) => item.kind === "validation")?.data)
      .toMatchObject({ workspaceDeltaEvidenceIds: ["survivor-delta"] });
    expect(reconciled.evidence.find((item) => item.kind === "review")?.data)
      .toMatchObject({ workspaceDeltaEvidenceIds: ["survivor-delta"] });
    expect(() => assertKernelInvariants(reconciled)).not.toThrow();

    const replayed = evolve(reconciled, {
      ...envelope(reconciled, "checkpoint.restored", restored), authority: "user"
    });
    expect(replayed.evidence).toEqual(reconciled.evidence);
    expect(replayed.mutationEvidence).toEqual(reconciled.mutationEvidence);
    expect(replayed.checkpointHead).toEqual(reconciled.checkpointHead);

    const crossRunSeal = apply(replayed, "checkpoint.sealed", {
      ...restored, status: "sealed", sealedAt: "2026-01-01T00:00:03.000Z"
    });
    expect(crossRunSeal.checkpointHead).toEqual(replayed.checkpointHead);
    const foreignRunRestore = evolve(crossRunSeal, {
      ...envelope(crossRunSeal, "checkpoint.restored", restored), runId: "foreign-run"
    });
    expect(foreignRunRestore.checkpointHead).toEqual(replayed.checkpointHead);
    expect(apply(foreignRunRestore, "checkpoint.restored", { malformed: true }).checkpointHead)
      .toEqual(replayed.checkpointHead);
    expect(() => evolve(foreignRunRestore, {
      ...envelope(foreignRunRestore, "checkpoint.restored", restored), sessionId: "foreign-session"
    })).toThrow("Kernel event session mismatch");
  });

  it("freezes builtin identities and only complete skill execution manifests", () => {
    let state = initial();
    const forgedByUser = evolve(state, {
      ...envelope(state, "evidence.recorded", diagnosticEvidence("user-forgery")), authority: "user"
    });
    expect(forgedByUser.evidence).toEqual([]);

    state = apply(forgedByUser, "profile.resolved", {
      profileId: "builtin:secure", digest: "a".repeat(64), artifactId: "b".repeat(64), source: "builtin"
    });
    expect(state.frozenProfile).toMatchObject({ qualifiedName: "builtin:secure", source: "builtin" });

    state = apply(state, "skill.loaded", {
      qualifiedName: "builtin:typescript", digest: "c".repeat(64), artifactId: "d".repeat(64), source: "builtin",
      executionManifestArtifactId: "a".repeat(64), executionManifestDigest: "b".repeat(64)
    });
    expect(state.frozenSkills.at(-1)).toMatchObject({
      qualifiedName: "builtin:typescript", source: "builtin",
      executionManifestArtifactId: "a".repeat(64), executionManifestDigest: "b".repeat(64)
    });

    state = apply(state, "skill.loaded", {
      qualifiedName: "workspace:invalid-artifact", digest: "c".repeat(64), artifactId: "d".repeat(64),
      source: "workspace", executionManifestArtifactId: "not-a-digest", executionManifestDigest: "b".repeat(64)
    });
    state = apply(state, "skill.loaded", {
      qualifiedName: "workspace:missing-manifest-digest", digest: "c".repeat(64), artifactId: "d".repeat(64),
      source: "workspace", executionManifestArtifactId: "c".repeat(64)
    });
    state = apply(state, "skill.loaded", {
      qualifiedName: "workspace:invalid-manifest-digest", digest: "c".repeat(64), artifactId: "d".repeat(64),
      source: "workspace", executionManifestArtifactId: "c".repeat(64), executionManifestDigest: "not-a-digest"
    });
    expect(state.frozenSkills.slice(-3).every((item) => item.executionManifestArtifactId === undefined)).toBe(true);
  });
});
