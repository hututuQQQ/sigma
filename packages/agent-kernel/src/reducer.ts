import type {
  AgentEventEnvelope,
  AgentEventType,
  JsonValue,
  RunOutcome
} from "agent-protocol";
import { durableReducers, type KernelEventReducer } from "./durable-reducers.js";
import {
  lengthContinuationMessage,
  modelReducers,
  resetModelCompletion
} from "./model-reducers.js";
import { acceptMutationFrontier } from "./mutation-frontier.js";
import { receiptContent, toolReceipt } from "./receipt-parsing.js";
import {
  acceptsOutcomeRevision,
  isRecoverySuspension,
  nextPhase,
  objectPayload,
  pendingForEvent,
  proposedOutcomeState,
  supersededToolMessages,
  terminalOutcome,
  terminalState,
  text,
  withDuplicateActionAdvisory
} from "./reducer-helpers.js";
import type { KernelState } from "./state.js";

type EventReducer = KernelEventReducer;

const runStarted: EventReducer = (state, _event, payload) => ({
  ...state,
  mode: payload.mode === "analyze" || payload.mode === "change" ? payload.mode : state.mode,
  phase: state.messages.length > 0 ? "ready_model" : "idle",
  deadlineAt: typeof payload.deadlineAt === "string" ? payload.deadlineAt : state.deadlineAt,
  deadlineRemainingMs: undefined,
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  ...resetModelCompletion,
  outcome: undefined,
  proposedOutcome: undefined
});

const userInput: EventReducer = (state, _event, payload) => ({
  ...state,
  phase: "ready_model",
  activeModelTurn: undefined,
  activeModelSemanticDelta: undefined,
  ...resetModelCompletion,
  messages: [...state.messages, { role: "user", content: text(payload.text) }],
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
  ...resetModelCompletion,
  pendingTools: [],
  proposedOutcome: undefined,
  outcome: undefined
});

const followUpInput: EventReducer = (state, _event, payload) => payload.status === "queued"
  ? state
  : {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      ...resetModelCompletion,
      messages: [...state.messages, { role: "user", content: text(payload.text) }],
      outcome: undefined,
      proposedOutcome: undefined
    };

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
  const resumed = deadlineAt
    ? { ...state, deadlineAt, deadlineRemainingMs: undefined }
    : state;
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
  const messages = [...state.messages, {
    role: "tool" as const,
    content: receiptContent(receipt),
    toolCallId: receipt.callId
  }];
  const next: KernelState = {
    ...state,
    messages,
    pendingTools,
    receipts: [...state.receipts, receipt],
    phase: nextPhase(pendingTools)
  };
  if (pendingTools.length > 0) return next;
  const assistant = [...state.messages].reverse().find((item) =>
    item.role === "assistant" && (item.toolCalls?.length ?? 0) > 0);
  const terminal = terminalOutcome(pending, receipt, assistant?.toolCalls ?? []);
  if (terminal) return proposedOutcomeState(next, terminal);
  const settledMessages = state.lastModelFinishReason === "length"
    && state.lastModelHadToolCalls
    ? [...messages, lengthContinuationMessage(true)]
    : messages;
  return { ...next, messages: withDuplicateActionAdvisory(settledMessages) };
};

function isApprovalSuspension(state: KernelState, payload: Record<string, JsonValue>): boolean {
  return pendingForEvent(state, payload)?.approval === "pending";
}

const runSuspended: EventReducer = (state, _event, payload) => {
  const proposedInput = Number.isInteger(payload.outcomeRevision)
    && acceptsOutcomeRevision(state, payload)
    && state.proposedOutcome?.kind === "needs_input";
  const legacyOrRuntimeSuspension = payload.outcomeRevision === undefined
    && (isApprovalSuspension(state, payload) || isRecoverySuspension(state, payload)
      || typeof payload.requestId === "string");
  if (!proposedInput && !legacyOrRuntimeSuspension) return state;
  return {
    ...state,
    ...(Number.isSafeInteger(payload.remainingDeadlineMs) && Number(payload.remainingDeadlineMs) >= 1
      ? { deadlineRemainingMs: Number(payload.remainingDeadlineMs) }
      : {}),
    phase: "needs_input",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    proposedOutcome: undefined,
    outcome: {
      kind: "needs_input",
      requestId: text(payload.requestId),
      message: text(payload.message)
    }
  };
};

const runFailed: EventReducer = (state, _event, payload) => {
  if (!acceptsOutcomeRevision(state, payload)) return state;
  const outcome: RunOutcome = payload.kind === "recoverable_failure"
    ? {
        kind: "recoverable_failure",
        code: text(payload.code) || "runtime_error",
        message: text(payload.message),
        ...(typeof payload.resumeToken === "string" ? { resumeToken: payload.resumeToken } : {}),
        ...(payload.failureKind === "blocked" ? { failureKind: "blocked" as const } : {}),
        ...(payload.failureKind === "blocked" && typeof payload.failureCode === "string"
          ? { failureCode: payload.failureCode }
          : {})
      }
    : {
        kind: "fatal",
        code: text(payload.code) || "runtime_error",
        message: text(payload.message)
      };
  return terminalState(state, outcome);
};

const runCompleted: EventReducer = (state, _event, payload) => {
  if (!Number.isInteger(payload.outcomeRevision) || !acceptsOutcomeRevision(state, payload)
    || state.proposedOutcome?.kind !== "completed") return state;
  return terminalState({
    ...state,
    mutationFrontier: acceptMutationFrontier(state.mutationFrontier)
  }, {
    ...state.proposedOutcome,
    message: text(payload.message) || state.proposedOutcome.message,
    evidence: state.evidence
  });
};

const diagnostic: EventReducer = (state, _event, payload) => {
  if (payload.kind === "steering.restart" || payload.kind === "tool.batch_settled") return state;
  if (payload.kind === "recovery.retry_model") {
    const message = text(payload.message);
    return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      proposedOutcome: undefined,
      outcome: undefined,
      ...(message
        ? { messages: [...state.messages, { role: "developer" as const, content: message }] }
        : {})
    };
  }
  if (payload.kind === "completion.advisory") {
    const message = text(payload.message);
    if (!message) return state;
    return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      proposedOutcome: undefined,
      outcome: undefined,
      messages: [...state.messages, { role: "developer", content: message }]
    };
  }
  if (payload.kind === "child.join_failed") {
    const failures = Array.isArray(payload.failures)
      ? payload.failures.filter((item): item is string => typeof item === "string")
      : [];
    return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
      proposedOutcome: undefined,
      outcome: undefined,
      messages: [...state.messages, {
        role: "developer",
        content: `Completion is blocked by unresolved child work: ${failures.join("; ")}. `
          + "Inspect the child and integrate or replace its result before completing."
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
  return {
    ...state,
    pendingTools,
    phase: nextPhase(pendingTools),
    outcome: undefined,
    proposedOutcome: undefined
  };
};

const reducers: Partial<Record<AgentEventType, EventReducer>> = {
  "run.started": runStarted,
  "user.message": userInput,
  "user.steer": steeringInput,
  "user.follow_up": followUpInput,
  ...modelReducers,
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
  if (event.seq <= previous.lastSeq) {
    throw new Error(`Kernel event sequence must increase: ${event.seq} <= ${previous.lastSeq}`);
  }
  if (previous.phase === "terminal" && event.type !== "review.waived") return previous;
  const state: KernelState = {
    ...previous,
    revision: previous.revision + 1,
    lastSeq: event.seq
  };
  return reducers[event.type]?.(state, event, objectPayload(event.payload)) ?? state;
}
