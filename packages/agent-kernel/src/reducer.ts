import type {
  AgentEventEnvelope,
  AgentEventType,
  CompletionLimitationV1,
  JsonValue,
  ModelMessage,
  RunOutcome
} from "agent-protocol";
import type { KernelState } from "./state.js";
import {
  completionRepairFailureMessage,
  protectedCompletionAnswer
} from "./model-convergence.js";
import { durableReducers, type KernelEventReducer } from "./durable-reducers.js";
import { isCurrentModelTurn, modelTurn } from "./model-event-parsing.js";
import { acceptMutationFrontier } from "./mutation-frontier.js";
import { toolFinished } from "./tool-finished-reducer.js";
import { modelCompleted } from "./model-completed-reducer.js";
import {
  acceptsOutcomeRevision,
  isRecoverySuspension,
  nextPhase,
  pendingForEvent,
  proposedOutcomeState,
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
type EventReducer = KernelEventReducer;
const runStarted: EventReducer = (state, _event, payload) => ({
  ...state,
  mode: payload.mode === "analyze" || payload.mode === "change" ? payload.mode : state.mode,
  phase: state.messages.length > 0 ? "ready_model" : "idle",
  deadlineAt: typeof payload.deadlineAt === "string" ? payload.deadlineAt : state.deadlineAt,
  validationRequirement: payload.validationRequirement === "default" ? "default" : "required",
  deadlineRemainingMs: undefined,
  convergenceStageHighWater: {
    runId: state.runId,
    deadline: "normal",
    budget: "normal"
  },
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  completionRepairAttempts: 0,
  completionRepair: undefined,
  continuationAttempts: 0,
  lengthFinishDebt: 0,
  lengthProgressFingerprint: undefined,
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
  // A delivered user message is the trusted authority for the current run's
  // goal. Model-owned update_plan calls may restructure the DAG but cannot
  // later rewrite this validation-bearing text.
  plan: { ...state.plan, goal: text(payload.text) },
  completionRepairAttempts: 0,
  completionRepair: undefined,
  continuationAttempts: 0,
  lengthFinishDebt: 0,
  lengthProgressFingerprint: undefined,
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
  validationRequirement: payload.validationRequirement === "default" ? "default" : "required",
  plan: { ...state.plan, goal: text(payload.text) },
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
  lengthFinishDebt: 0,
  lengthProgressFingerprint: undefined,
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
  const outcome: RunOutcome = payload.kind === "completed_with_limitations" && Array.isArray(payload.limitations)
    ? {
      kind: "completed_with_limitations",
      message: state.proposedOutcome.message,
      evidence: state.evidence,
      limitations: payload.limitations as unknown as CompletionLimitationV1[]
    }
    : { ...state.proposedOutcome, evidence: state.evidence };
  return terminalState({
    ...state,
    mutationFrontier: acceptMutationFrontier(state.mutationFrontier)
  }, outcome);
};

const DEADLINE_STAGE_RANK = { normal: 0, converge: 1, stop: 2 } as const;
const BUDGET_STAGE_RANK = { normal: 0, converge: 1, terminal: 2 } as const;

function convergenceStageUpdate(
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Record<string, JsonValue>
): KernelState | undefined {
  if (payload.kind !== "deadline.stage" || event.authority !== "runtime" || event.runId !== state.runId) {
    return undefined;
  }
  const deadline = payload.stage === "normal" || payload.stage === "converge" || payload.stage === "stop"
    ? payload.stage : "normal";
  const prior = state.convergenceStageHighWater?.runId === state.runId
    ? state.convergenceStageHighWater
    : { runId: state.runId, deadline: "normal" as const, budget: "normal" as const };
  // Legacy events exposed only the effective budget stage, which could have
  // been raised by transient action debt. It is deliberately not replayed as
  // durable resource pressure because its provenance is ambiguous.
  const resourceBudget = payload.resourceBudgetStage === "normal"
    || payload.resourceBudgetStage === "converge"
    || payload.resourceBudgetStage === "terminal" ? payload.resourceBudgetStage : prior.budget;
  return {
    ...state,
    convergenceStageHighWater: {
      runId: state.runId,
      deadline: DEADLINE_STAGE_RANK[deadline] > DEADLINE_STAGE_RANK[prior.deadline]
        ? deadline : prior.deadline,
      budget: BUDGET_STAGE_RANK[resourceBudget] > BUDGET_STAGE_RANK[prior.budget]
        ? resourceBudget : prior.budget
    }
  };
}

function modelToolPolicyUpdate(
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Record<string, JsonValue>
): KernelState | undefined {
  if (payload.kind !== "model.tool_policy" || event.authority !== "runtime"
    || event.runId !== state.runId || state.phase !== "model_in_flight"
    || !isCurrentModelTurn(state, payload) || !Array.isArray(payload.allowedToolNames)
    || typeof payload.terminalOnly !== "boolean") return undefined;
  const allowedToolNames = payload.allowedToolNames.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  if (allowedToolNames.length !== payload.allowedToolNames.length
    || allowedToolNames.length > 512
    || new Set(allowedToolNames).size !== allowedToolNames.length) return undefined;
  return {
    ...state,
    activeModelTurn: {
      ...state.activeModelTurn!,
      toolPolicy: { allowedToolNames, terminalOnly: payload.terminalOnly }
    }
  };
}

const diagnostic: EventReducer = (state, event, payload) => {
  // user.steer is the durable authority for superseding a turn. The later
  // steering.restart event is observational only: applying it could erase a
  // newer turn that completed while the cancelled provider was unwinding.
  if (payload.kind === "steering.restart") return state;
  const toolPolicy = modelToolPolicyUpdate(state, event, payload);
  if (toolPolicy) return toolPolicy;
  const convergence = convergenceStageUpdate(state, event, payload);
  if (convergence) return convergence;
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
