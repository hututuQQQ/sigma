import type { AgentEventEnvelope, AgentEventType, JsonValue, ModelMessage, ModelToolCall, RunOutcome } from "agent-protocol";
import type { ActiveModelTurn, KernelState, PendingTool } from "./state.js";
import { completionSummary, incompleteModelCompletion, requestedInput, toolBatchSignature } from "./model-convergence.js";
import { receiptContent, toolReceipt } from "./receipt-parsing.js";
import { durableReducers, type KernelEventReducer } from "./durable-reducers.js";
import { isCurrentModelTurn, modelMessage, modelToolCalls, modelTurn } from "./model-event-parsing.js";
import { recordSemanticToolResult, SEMANTIC_INFRASTRUCTURE_FAILURE_CODE } from "./semantic-failures.js";

function objectPayload(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function supersededToolMessages(state: KernelState): ModelMessage[] {
  return state.pendingTools.map((pending) => ({
    role: "tool",
    toolCallId: pending.request.callId,
    content: `Failed tool receipt ID: ${pending.request.callId}\nSuperseded by a newer user instruction; no successful receipt or side effect may be inferred.`
  }));
}

function terminal(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "terminal",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    pendingTools: [],
    proposedOutcome: undefined,
    outcome
  };
}

function propose(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "outcome_pending",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    proposedOutcome: outcome
  };
}

function nextPhase(pending: PendingTool[]): KernelState["phase"] {
  if (pending.some((item) => item.approval === "pending")) return "needs_input";
  if (pending.some((item) => item.started)) return "tool_in_flight";
  return pending.length > 0 ? "tool_pending" : "ready_model";
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
  continuationAttempts: 0,
  repeatedToolBatchCount: 0,
  receiptCountAtLastUserInput: state.receipts.length,
  semanticProgress: { workspaceChanges: 0, durableEvidence: 0, revision: state.revision },
  semanticFailureCluster: undefined,
  lastToolBatchSignature: undefined,
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
  continuationAttempts: 0,
  repeatedToolBatchCount: 0,
  receiptCountAtLastUserInput: state.receipts.length,
  semanticFailureCluster: undefined,
  lastToolBatchSignature: undefined,
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
  continuationAttempts: 0,
  repeatedToolBatchCount: 0,
  receiptCountAtLastUserInput: state.receipts.length,
  semanticFailureCluster: undefined,
  lastToolBatchSignature: undefined,
  proposedOutcome: undefined,
  outcome: undefined
});

const followUpInput: EventReducer = (state, event, payload) => payload.status === "queued"
  ? state
  : userInput(state, event, payload);

function pendingForEvent(state: KernelState, payload: Record<string, JsonValue>): PendingTool | undefined {
  const turn = modelTurn(payload);
  const callId = text(payload.callId);
  if (!turn || !callId) return undefined;
  return state.pendingTools.find((item) => item.request.callId === callId
    && item.modelTurn.turnId === turn.turnId
    && item.modelTurn.effectRevision === turn.effectRevision);
}

function acceptsOutcomeRevision(state: KernelState, payload: Record<string, JsonValue>): boolean {
  if (payload.outcomeRevision === undefined) return true;
  return Number.isInteger(payload.outcomeRevision)
    && payload.outcomeRevision === state.revision - 1
    && state.phase === "outcome_pending";
}

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
  const identifiers = calls.map((call) => call.id);
  const seen = new Set(state.toolCallIds);
  const duplicate = identifiers.find((id, index) => identifiers.indexOf(id) !== index || seen.has(id));
  if (duplicate) {
    return propose({ ...completedState, messages }, {
      kind: "recoverable_failure",
      code: "protocol_error",
      message: `Model reused tool call id '${duplicate}' within the current run.`
    });
  }
  const signature = toolBatchSignature(calls);
  const repeatedToolBatchCount = signature === state.lastToolBatchSignature
    ? state.repeatedToolBatchCount + 1 : 1;
  if (repeatedToolBatchCount >= 3) {
    return propose({
      ...completedState,
      messages,
      toolCallIds: [...state.toolCallIds, ...identifiers],
      lastToolBatchSignature: signature,
      repeatedToolBatchCount
    }, {
      kind: "recoverable_failure",
      code: "agent_no_progress",
      message: "The model proposed the same tool batch three times without an intervening action."
    });
  }
  const pendingTools = pendingFromCalls(calls, modelTurn);
  return {
    ...completedState,
    messages,
    pendingTools,
    toolCallIds: [...state.toolCallIds, ...identifiers],
    completionRepairAttempts: 0,
    continuationAttempts: 0,
    lastToolBatchSignature: signature,
    repeatedToolBatchCount,
    phase: "tool_pending"
  };
};

const modelFailed: EventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)) return state;
  return propose(state, {
    kind: "recoverable_failure",
    code: text(payload.code) || "model_error",
    message: text(payload.message)
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
    completionRepairAttempts: 0,
    continuationAttempts: 0,
    phase: nextPhase(pendingTools)
  };
  const semantic = recordSemanticToolResult(next, receipt);
  const progressed = semantic.state;
  const inputMessage = requestedInput(receipt);
  if (inputMessage) {
    return propose(progressed, { kind: "needs_input", requestId: receipt.callId, message: inputMessage });
  }
  const summary = completionSummary(receipt);
  if (summary) return propose(progressed, { kind: "completed", message: summary, evidence: progressed.evidence });
  if (semantic.limitReached && pendingTools.length === 0 && progressed.semanticFailureCluster) {
    const cluster = progressed.semanticFailureCluster;
    return propose(progressed, {
      kind: "recoverable_failure",
      code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE,
      message: `Execution infrastructure repeatedly failed without workspace or durable evidence progress (${cluster.family}, ${cluster.attempts} attempts; diagnostics: ${cluster.diagnosticCodes.join(", ")}).`
    });
  }
  return progressed;
};

const runSuspended: EventReducer = (state, _event, payload) => {
  if (text(payload.callId) && !pendingForEvent(state, payload)) return state;
  return {
    ...state,
    ...(Number.isSafeInteger(payload.remainingDeadlineMs) && Number(payload.remainingDeadlineMs) >= 1
      ? { deadlineRemainingMs: Number(payload.remainingDeadlineMs) } : {}),
    phase: "needs_input",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
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
      message: text(payload.message),
      ...(typeof payload.resumeToken === "string" ? { resumeToken: payload.resumeToken } : {})
    }
    : { kind: "fatal", code: text(payload.code) || "runtime_error", message: text(payload.message) };
  return terminal(state, outcome);
};

const runCompleted: EventReducer = (state, _event, payload) => {
  if (!Number.isInteger(payload.outcomeRevision) || !acceptsOutcomeRevision(state, payload)
    || state.proposedOutcome?.kind !== "completed") return state;
  return terminal(state, { ...state.proposedOutcome, evidence: state.evidence });
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
    return {
      ...state,
      phase: "ready_model",
      activeModelTurn: undefined,
      activeModelSemanticDelta: undefined,
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
  "run.cancelled": (state, _event, payload) => terminal(state, {
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
