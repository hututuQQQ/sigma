import type { AgentEventEnvelope, AgentEventType, JsonValue, ModelMessage, ModelToolCall, RunOutcome } from "agent-protocol";
import type { ActiveModelTurn, KernelState, PendingTool } from "./state.js";
import {
  completionRepairFailureMessage,
  completionRepairRequiresTerminalAction,
  hasCompletionRepair,
  incompleteModelCompletion,
  protectedCompletionAnswer
} from "./model-convergence.js";
import { receiptContent, toolReceipt } from "./receipt-parsing.js";
import { durableReducers, type KernelEventReducer } from "./durable-reducers.js";
import { isCurrentModelTurn, modelMessage, modelToolCalls, modelTurn } from "./model-event-parsing.js";
import { recordSemanticToolResult } from "./semantic-failures.js";
import { acceptMutationFrontier } from "./mutation-frontier.js";
import { completedToolBatchProgress, startedToolBatchProgress } from "./tool-batch-progress.js";
import { beginGoalEpoch, terminalResolutionObligation } from "./task-control.js";
import { runtimeDependencyDiagnostic } from "./runtime-dependency-reducer.js";
import {
  repositoryRecoveryDecisionState,
  resumeRepositoryRecoveryDecision
} from "./repository-task-control.js";
import {
  acceptsOutcomeRevision,
  isRecoverySuspension,
  nextPhase,
  pendingForEvent,
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
  taskControl: state.taskControl,
  outcome: undefined,
  proposedOutcome: undefined
});

const userInput: EventReducer = (state, _event, payload) => ({
  ...state,
  phase: "ready_model",
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  messages: [...state.messages, { role: "user", content: text(payload.text) }],
  taskControl: beginGoalEpoch(state.taskControl, state.revision, "submit"),
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
  taskControl: beginGoalEpoch(state.taskControl, state.revision, "steer"),
  proposedOutcome: undefined,
  outcome: undefined
});

const followUpInput: EventReducer = (state, _event, payload) => {
  if (payload.status === "queued") return state;
  const repositoryDecision = resumeRepositoryRecoveryDecision(
    state.taskControl,
    state.revision
  );
  return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      messages: [...state.messages, { role: "user", content: text(payload.text) }],
      taskControl: repositoryDecision
        ?? beginGoalEpoch(state.taskControl, state.revision, "follow_up"),
      outcome: undefined,
      proposedOutcome: undefined
    };
};

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
  const completedState = {
    ...state,
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined
  };
  if (calls.length === 0) return incompleteModelCompletion(completedState, payload, messages);
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
  const pendingTools = pendingFromCalls(calls, modelTurn);
  const taskControl = startedToolBatchProgress({
    ...completedState,
    taskControl: { ...completedState.taskControl, modelContinuationAttempts: 0 }
  }).taskControl;
  return {
    ...completedState,
    taskControl,
    messages,
    pendingTools,
    toolCallIds: [...state.toolCallIds, ...identifiers],
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
    taskControl: { ...state.taskControl, modelContinuationAttempts: 0 },
    phase: nextPhase(pendingTools)
  };
  const semantic = recordSemanticToolResult(next, receipt, pending.request.name);
  const decisionState = repositoryRecoveryDecisionState(
    semantic.state,
    pending.request.name,
    receipt
  );
  const progressed = pendingTools.length === 0
    ? { ...decisionState, ...completedToolBatchProgress(decisionState) }
    : decisionState;
  return terminalReceiptTransition({
    state,
    progressed,
    receipt,
    toolName: pending.request.name,
    remainingTools: pendingTools.length,
    repairPending,
    terminalRepairPending,
    semanticLimitReached: progressed.taskControl.phase === "terminal"
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
    taskControl: state.taskControl,
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
      ...(typeof payload.resumeToken === "string" ? { resumeToken: payload.resumeToken } : {}),
      ...(payload.failureKind === "blocked" ? { failureKind: "blocked" as const } : {}),
      ...(payload.failureKind === "blocked" && typeof payload.failureCode === "string" ? { failureCode: payload.failureCode } : {})
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
  return terminalState({
    ...state,
    mutationFrontier: acceptMutationFrontier(state.mutationFrontier)
  }, { ...state.proposedOutcome, evidence: state.evidence });
};

const diagnostic: EventReducer = (state, event, payload) => {
  const dependency = runtimeDependencyDiagnostic(state, event, payload);
  if (dependency) return dependency;
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
  if (payload.kind === "tool.batch_settled") {
    const obligation = state.taskControl.obligation;
    if (obligation?.kind !== "review_repair" || obligation.stage === "re_review") return state;
    const diagnosticCodes = Array.isArray(payload.diagnosticCodes)
      ? payload.diagnosticCodes.filter((item): item is string => typeof item === "string") : [];
    if (diagnosticCodes.some((code) => code === "model_tool_policy_violation"
      || code === "tool_unavailable_for_repair")) return state;
    return {
      ...state,
      taskControl: terminalResolutionObligation(
        state.taskControl,
        state.revision,
        obligation.stage === "mutate" ? "review_repair_no_delta" : "validation_evidence_missing"
      )
    };
  }
  if (payload.kind === "child.join_failed") {
    const failures = Array.isArray(payload.failures) ? payload.failures.filter((item): item is string => typeof item === "string") : [];
    return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      taskControl: state.taskControl,
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
