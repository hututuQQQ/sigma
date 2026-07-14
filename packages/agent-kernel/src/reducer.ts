import type { AgentEventEnvelope, AgentEventType, JsonValue, ModelMessage, ModelToolCall, RunOutcome } from "agent-protocol";
import type { ActiveModelTurn, KernelState, PendingTool } from "./state.js";
import {
  completionRepairFailureMessage,
  completionRepairRequiresTerminalAction,
  conflictingTerminalBatch,
  hasCompletionRepair,
  incompleteModelCompletion,
  protectedCompletionAnswer,
  repairConflictingTerminalBatch
} from "./model-convergence.js";
import { receiptContent, toolReceipt } from "./receipt-parsing.js";
import { durableReducers, type KernelEventReducer } from "./durable-reducers.js";
import { isCurrentModelTurn, modelMessage, modelToolCalls, modelTurn } from "./model-event-parsing.js";
import { recordSemanticToolResult } from "./semantic-failures.js";
import { completedToolBatchProgress, repeatsCompletedToolBatch } from "./tool-batch-progress.js";
import {
  acceptsOutcomeRevision,
  isRecoverySuspension,
  nextPhase,
  pendingForEvent,
  protectedToolBatchFailure,
  proposedOutcomeState,
  terminalReceiptTransition,
  terminalState
} from "./terminal-reducer-helpers.js";
function objectPayload(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
function text(value: JsonValue | undefined): string { return typeof value === "string" ? value : ""; }
function supersededToolMessages(state: KernelState): ModelMessage[] {
  return state.pendingTools.map((pending) => ({
    role: "tool",
    toolCallId: pending.request.callId,
    content: `Failed tool receipt ID: ${pending.request.callId}\nSuperseded by a newer user instruction; no successful receipt or side effect may be inferred.`
  }));
}
function pendingFromCalls(calls: ModelToolCall[], modelTurn: ActiveModelTurn): PendingTool[] {
  return calls.map((call): PendingTool => ({
    request: { callId: call.id, name: call.name, arguments: call.arguments },
    modelTurn,
    approval: "not_required",
    started: false
  }));
}

type EventReducer = KernelEventReducer;
const runStarted: EventReducer = (state, _event, payload) => ({
  ...state,
  mode: payload.mode === "analyze" || payload.mode === "change" ? payload.mode : state.mode,
  phase: state.messages.length > 0 ? "ready_model" : "idle",
  deadlineAt: typeof payload.deadlineAt === "string" ? payload.deadlineAt : state.deadlineAt,
  deadlineRemainingMs: undefined,
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  completionRepairAttempts: 0,
  completionRepair: undefined,
  continuationAttempts: 0,
  repeatedToolBatchCount: 0,
  receiptCountAtLastUserInput: state.receipts.length,
  semanticProgress: { workspaceChanges: 0, durableEvidence: 0, revision: state.revision },
  semanticFailureCluster: undefined,
  lastToolBatchSignature: undefined,
  lastToolBatchOutcomeSignature: undefined,
  outcome: undefined,
  proposedOutcome: undefined
});

const userInput: EventReducer = (state, _event, payload) => ({
  ...state,
  phase: "ready_model",
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  messages: [...state.messages, { role: "user", content: text(payload.text) }],
  completionRepairAttempts: 0,
  completionRepair: undefined,
  continuationAttempts: 0,
  repeatedToolBatchCount: 0,
  receiptCountAtLastUserInput: state.receipts.length,
  semanticFailureCluster: undefined,
  lastToolBatchSignature: undefined,
  lastToolBatchOutcomeSignature: undefined,
  outcome: undefined,
  proposedOutcome: undefined
});

const steeringInput: EventReducer = (state, _event, payload) => ({
  ...state,
  messages: [
    ...state.messages,
    ...supersededToolMessages(state),
    { role: "user", content: text(payload.text) }
  ],
  phase: "ready_model",
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  pendingTools: [],
  completionRepairAttempts: 0,
  completionRepair: undefined,
  continuationAttempts: 0,
  repeatedToolBatchCount: 0,
  receiptCountAtLastUserInput: state.receipts.length,
  semanticFailureCluster: undefined,
  lastToolBatchSignature: undefined,
  lastToolBatchOutcomeSignature: undefined,
  proposedOutcome: undefined,
  outcome: undefined
});

const followUpInput: EventReducer = (state, event, payload) => payload.status === "queued"
  ? state
  : userInput(state, event, payload);

const modelStarted: EventReducer = (state, _event, payload) => {
  const turn = modelTurn(payload);
  if (state.phase !== "ready_model" || !turn || turn.effectRevision !== state.revision - 1) return state;
  return { ...state, phase: "model_in_flight", activeModelTurn: turn, activeModelSemanticDelta: false };
};

const modelSemanticDelta: EventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !state.activeModelTurn
    || payload.turnId !== state.activeModelTurn.turnId) return state;
  return { ...state, activeModelSemanticDelta: true };
};

const modelCompleted: EventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)) return state;
  const message = modelMessage(payload.message);
  const messages = message ? [...state.messages, message] : state.messages;
  const calls = modelToolCalls(payload.toolCalls);
  const modelTurn = state.activeModelTurn!;
  const completedState = { ...state, activeModelTurn: undefined, activeModelSemanticDelta: undefined };
  if (calls.length === 0) return incompleteModelCompletion(completedState, payload, messages);
  const protectedFailure = protectedToolBatchFailure(state, calls);
  if (protectedFailure) {
    return proposedOutcomeState({ ...completedState, messages }, {
      kind: "recoverable_failure",
      code: protectedFailure.code,
      message: completionRepairFailureMessage(state, protectedFailure.message)
    });
  }
  const identifiers = calls.map((call) => call.id);
  const seen = new Set(state.toolCallIds);
  const duplicate = identifiers.find((id, index) => identifiers.indexOf(id) !== index || seen.has(id));
  if (duplicate) {
    return proposedOutcomeState({ ...completedState, messages }, {
      kind: "recoverable_failure",
      code: "protocol_error",
      message: completionRepairFailureMessage(
        state,
        `Model reused tool call id '${duplicate}' within the current run.`
      )
    });
  }
  if (conflictingTerminalBatch(calls, hasCompletionRepair(state))) {
    return repairConflictingTerminalBatch({ ...completedState, messages }, messages);
  }
  if (repeatsCompletedToolBatch(state, calls)) {
    return proposedOutcomeState({
      ...completedState,
      messages,
      toolCallIds: [...state.toolCallIds, ...identifiers]
    }, {
      kind: "recoverable_failure",
      code: "agent_no_progress",
      message: completionRepairFailureMessage(
        state,
        "The same tool batch produced the same completed outcome twice and was proposed again without progress."
      )
    });
  }
  const pendingTools = pendingFromCalls(calls, modelTurn);
  return {
    ...completedState,
    messages,
    pendingTools,
    toolCallIds: [...state.toolCallIds, ...identifiers],
    completionRepairAttempts: state.completionRepairAttempts,
    continuationAttempts: 0,
    phase: "tool_pending"
  };
};

const modelFailed: EventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)) return state;
  return proposedOutcomeState(state, {
    kind: "recoverable_failure",
    code: text(payload.code) || "model_error",
    message: completionRepairFailureMessage(state, text(payload.message))
  });
};

// model.completed is the authority that creates pending tool work. Requested
// is a durable lifecycle marker and must never resurrect a superseded call.
const toolRequested: EventReducer = (state) => state;

const approvalRequested: EventReducer = (state, _event, payload) => {
  const pending = pendingForEvent(state, payload);
  if (!pending) return state;
  const pendingTools = state.pendingTools.map((item) => item === pending
    ? { ...item, approval: "pending" as const }
    : item);
  return { ...state, pendingTools, phase: "needs_input" };
};

const approvalResolved: EventReducer = (state, _event, payload) => {
  const deadlineAt = typeof payload.deadlineAt === "string" ? payload.deadlineAt : undefined;
  const resumed = deadlineAt ? { ...state, deadlineAt, deadlineRemainingMs: undefined } : state;
  const pending = pendingForEvent(state, payload);
  if (!pending) return resumed;
  const allowed = payload.decision === "allow" || payload.decision === "always_allow";
  const pendingTools = resumed.pendingTools.map((item) => item === pending
    ? { ...item, approval: allowed ? "allowed" as const : "denied" as const }
    : item);
  return { ...resumed, pendingTools, phase: nextPhase(pendingTools), outcome: undefined };
};

const toolStarted: EventReducer = (state, _event, payload) => {
  const pending = pendingForEvent(state, payload);
  if (!pending) return state;
  const pendingTools = state.pendingTools.map((item) => item === pending
    ? { ...item, started: true }
    : item);
  return { ...state, pendingTools, phase: "tool_in_flight" };
};

const toolFinished: EventReducer = (state, event) => {
  const receipt = toolReceipt(event.payload);
  const pending = pendingForEvent(state, objectPayload(event.payload));
  if (!receipt || !pending || pending.request.callId !== receipt.callId) return state;
  const pendingTools = state.pendingTools.filter((item) => item !== pending);
  const repairPending = hasCompletionRepair(state);
  const terminalRepairPending = completionRepairRequiresTerminalAction(state);
  const next: KernelState = {
    ...state,
    messages: [...state.messages, {
      role: "tool",
      content: receiptContent(receipt),
      toolCallId: receipt.callId
    }],
    pendingTools,
    receipts: [...state.receipts, receipt],
    // Receipt evidence is untrusted tool output. Only separately emitted,
    // authority-checked evidence.recorded/review events enter the ledger.
    evidence: state.evidence,
    continuationAttempts: 0,
    phase: nextPhase(pendingTools)
  };
  const completedBatch = pendingTools.length === 0 ? completedToolBatchProgress(next, receipt.callId) : {};
  const semantic = recordSemanticToolResult({ ...next, ...completedBatch }, receipt, pending.request.name);
  const progressed = semantic.state;
  return terminalReceiptTransition({
    state,
    progressed,
    receipt,
    toolName: pending.request.name,
    remainingTools: pendingTools.length,
    repairPending,
    terminalRepairPending,
    semanticLimitReached: semantic.limitReached
  }) ?? progressed;
};

function isApprovalSuspension(state: KernelState, payload: Record<string, JsonValue>): boolean {
  return pendingForEvent(state, payload)?.approval === "pending";
}

const runSuspended: EventReducer = (state, _event, payload) => {
  const proposedInputSuspension = Number.isInteger(payload.outcomeRevision)
    && acceptsOutcomeRevision(state, payload)
    && state.proposedOutcome?.kind === "needs_input";
  const approvalSuspension = isApprovalSuspension(state, payload);
  const recoverySuspension = isRecoverySuspension(state, payload);
  const legacySuspension = !protectedCompletionAnswer(state)
    && payload.outcomeRevision === undefined
    && payload.callId === undefined;
  if (!proposedInputSuspension && !approvalSuspension && !recoverySuspension && !legacySuspension) return state;
  return {
    ...state,
    ...(Number.isSafeInteger(payload.remainingDeadlineMs) && Number(payload.remainingDeadlineMs) >= 1
      ? { deadlineRemainingMs: Number(payload.remainingDeadlineMs) } : {}),
    phase: "needs_input",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    ...(!approvalSuspension ? { completionRepairAttempts: 0, completionRepair: undefined } : {}),
    proposedOutcome: undefined,
    outcome: { kind: "needs_input", requestId: text(payload.requestId), message: text(payload.message) }
  };
};

const runFailed: EventReducer = (state, _event, payload) => {
  if (!acceptsOutcomeRevision(state, payload)) return state;
  const outcome: RunOutcome = payload.kind === "recoverable_failure"
    ? {
      kind: "recoverable_failure",
      code: text(payload.code) || "runtime_error",
      message: completionRepairFailureMessage(state, text(payload.message)),
      ...(typeof payload.resumeToken === "string" ? { resumeToken: payload.resumeToken } : {})
    }
    : {
      kind: "fatal",
      code: text(payload.code) || "runtime_error",
      message: completionRepairFailureMessage(state, text(payload.message))
    };
  return terminalState(state, outcome);
};

const runCompleted: EventReducer = (state, _event, payload) => {
  if (!Number.isInteger(payload.outcomeRevision) || !acceptsOutcomeRevision(state, payload)
    || state.proposedOutcome?.kind !== "completed") return state;
  return terminalState(state, { ...state.proposedOutcome, evidence: state.evidence });
};

const diagnostic: EventReducer = (state, _event, payload) => {
  // user.steer is the durable authority for superseding a turn. The later
  // steering.restart event is observational only: applying it could erase a
  // newer turn that completed while the cancelled provider was unwinding.
  if (payload.kind === "steering.restart") return state;
  if (payload.kind === "recovery.retry_model") return {
    ...state,
    phase: "ready_model",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    outcome: undefined
  };
  if (payload.kind === "child.join_failed") {
    const failures = Array.isArray(payload.failures) ? payload.failures.filter((item): item is string => typeof item === "string") : [];
    const protectedAnswer = protectedCompletionAnswer(state);
    return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      completionRepairAttempts: 0,
      completionRepair: protectedAnswer
        ? { kind: "protected_recovery", answer: protectedAnswer }
        : undefined,
      proposedOutcome: undefined,
      outcome: undefined,
      messages: [...state.messages, {
        role: "developer",
        content: `Completion is blocked by unresolved child work: ${failures.join("; ")}. Inspect the child and integrate or replace its result before completing.`
      }]
    };
  }
  if (payload.kind !== "recovery.reset_tool") return state;
  const callId = text(payload.callId);
  const pendingTools = state.pendingTools.map((item) => item.request.callId === callId
    ? {
      ...item,
      started: false,
      approval: payload.approval === "pending" ? "pending" as const : "not_required" as const
    }
    : item);
  return { ...state, pendingTools, phase: nextPhase(pendingTools), outcome: undefined };
};

const reducers: Partial<Record<AgentEventType, EventReducer>> = {
  "run.started": runStarted,
  "user.message": userInput,
  "user.steer": steeringInput,
  "user.follow_up": followUpInput,
  "model.started": modelStarted,
  "model.delta": modelSemanticDelta,
  "model.reasoning_delta": modelSemanticDelta,
  "model.completed": modelCompleted,
  "model.failed": modelFailed,
  "tool.requested": toolRequested,
  "tool.approval_requested": approvalRequested,
  "tool.approval_resolved": approvalResolved,
  "tool.started": toolStarted,
  "tool.completed": toolFinished,
  "tool.failed": toolFinished,
  "run.suspended": runSuspended,
  "run.cancelled": (state, _event, payload) => terminalState(state, {
    kind: "cancelled",
    reason: text(payload.reason) || "cancelled"
  }),
  "run.failed": runFailed,
  "run.completed": runCompleted,
  ...durableReducers,
  diagnostic
};

export function evolve(previous: KernelState, event: AgentEventEnvelope): KernelState {
  if (event.sessionId !== previous.sessionId) throw new Error("Kernel event session mismatch.");
  if (event.seq <= previous.lastSeq) throw new Error(`Kernel event sequence must increase: ${event.seq} <= ${previous.lastSeq}`);
  // A terminal run may still be awaiting a user follow-up. The reviewer
  // waiver is the sole post-terminal evidence event and remains authority-
  // checked by its durable reducer; model/tool events stay inert.
  if (previous.phase === "terminal" && event.type !== "review.waived") return previous;
  const state: KernelState = { ...previous, revision: previous.revision + 1, lastSeq: event.seq };
  const reducer = reducers[event.type];
  return reducer ? reducer(state, event, objectPayload(event.payload)) : state;
}
