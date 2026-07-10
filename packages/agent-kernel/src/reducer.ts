import type {
  AgentEventEnvelope,
  AgentEventType,
  JsonValue,
  ModelMessage,
  ModelToolCall,
  RunOutcome,
  ToolEffect,
  ToolReceipt
} from "agent-protocol";
import type { ActiveModelTurn, KernelState, PendingTool } from "./state.js";

function objectPayload(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function modelToolCalls(value: JsonValue | undefined): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): ModelToolCall[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const call = raw as Record<string, JsonValue>;
    return typeof call.id === "string" && typeof call.name === "string"
      ? [{ id: call.id, name: call.name, arguments: call.arguments ?? null }]
      : [];
  });
}

function modelMessage(value: JsonValue | undefined): ModelMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, JsonValue>;
  const role = item.role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") return null;
  const toolCalls = modelToolCalls(item.toolCalls);
  return {
    role,
    content: text(item.content),
    ...(typeof item.reasoningContent === "string" ? { reasoningContent: item.reasoningContent } : {}),
    ...(typeof item.toolCallId === "string" ? { toolCallId: item.toolCallId } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {})
  };
}

function toolReceipt(value: JsonValue): ToolReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, JsonValue>;
  if (typeof item.callId !== "string" || typeof item.ok !== "boolean") return null;
  return {
    callId: item.callId,
    ok: item.ok,
    output: text(item.output),
    observedEffects: Array.isArray(item.observedEffects)
      ? item.observedEffects.filter((effect): effect is ToolEffect => typeof effect === "string")
      : [],
    artifacts: Array.isArray(item.artifacts) ? item.artifacts.filter((value): value is string => typeof value === "string") : [],
    diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics.filter((value): value is string => typeof value === "string") : [],
    startedAt: text(item.startedAt),
    completedAt: text(item.completedAt)
  };
}

function completionSummary(receipt: ToolReceipt): string | null {
  if (!receipt.ok || !receipt.observedEffects.includes("outcome.propose")) return null;
  try {
    const value = JSON.parse(receipt.output) as unknown;
    return value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string"
      ? (value as { summary: string }).summary : null;
  } catch {
    return null;
  }
}

function receiptContent(receipt: ToolReceipt): string {
  const status = receipt.ok ? "Successful" : "Failed";
  return `${status} tool receipt ID: ${receipt.callId}\n${receipt.output}`;
}

function supersededToolMessages(state: KernelState): ModelMessage[] {
  return state.pendingTools.map((pending) => ({
    role: "tool",
    toolCallId: pending.request.callId,
    content: `Failed tool receipt ID: ${pending.request.callId}\nSuperseded by a newer user instruction; no successful receipt or side effect may be inferred.`
  }));
}

function terminal(state: KernelState, outcome: RunOutcome): KernelState {
  return { ...state, phase: "terminal", activeModelTurn: undefined, pendingTools: [], proposedOutcome: undefined, outcome };
}

function propose(state: KernelState, outcome: RunOutcome): KernelState {
  return { ...state, phase: "outcome_pending", activeModelTurn: undefined, proposedOutcome: outcome };
}

function nextPhase(pending: PendingTool[]): KernelState["phase"] {
  if (pending.some((item) => item.approval === "pending")) return "needs_input";
  if (pending.some((item) => item.started)) return "tool_in_flight";
  return pending.length > 0 ? "tool_pending" : "ready_model";
}

function pendingFromCalls(calls: ModelToolCall[], modelTurn: ActiveModelTurn): PendingTool[] {
  const identifiers = new Set<string>();
  return calls.map((call): PendingTool => {
    if (identifiers.has(call.id)) {
      throw Object.assign(new Error(`Model returned duplicate tool call id '${call.id}'.`), { code: "protocol_error" });
    }
    identifiers.add(call.id);
    return {
      request: { callId: call.id, name: call.name, arguments: call.arguments },
      modelTurn,
      approval: "not_required",
      started: false
    };
  });
}

type EventReducer = (
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Record<string, JsonValue>
) => KernelState;

const runStarted: EventReducer = (state, _event, payload) => ({
  ...state,
  mode: payload.mode === "analyze" || payload.mode === "change" ? payload.mode : state.mode,
  phase: state.messages.length > 0 ? "ready_model" : "idle",
  deadlineAt: typeof payload.deadlineAt === "string" ? payload.deadlineAt : state.deadlineAt,
  activeModelTurn: undefined,
  outcome: undefined,
  proposedOutcome: undefined
});

const userInput: EventReducer = (state, _event, payload) => ({
  ...state,
  phase: "ready_model",
  messages: [...state.messages, { role: "user", content: text(payload.text) }]
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
  pendingTools: [],
  proposedOutcome: undefined,
  outcome: undefined
});

const followUpInput: EventReducer = (state, event, payload) => payload.status === "queued"
  ? state
  : userInput(state, event, payload);

function incompleteCompletion(state: KernelState, payload: Record<string, JsonValue>, messages: ModelMessage[]): KernelState {
  if (payload.finishReason === "length") return { ...state, messages, phase: "ready_model" };
  if (payload.finishReason === "content_filter") {
    return propose({ ...state, messages }, {
      kind: "fatal",
      code: "content_filter",
      message: "Provider blocked the response."
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "Completion was not accepted. Use complete_task with explicit criteria and successful tool receipt IDs; continue working if evidence is missing."
    }],
    phase: "ready_model"
  };
}

function modelTurn(payload: Record<string, JsonValue>): { turnId: number; effectRevision: number } | null {
  return Number.isInteger(payload.turnId) && Number.isInteger(payload.effectRevision)
    ? { turnId: Number(payload.turnId), effectRevision: Number(payload.effectRevision) }
    : null;
}

function isCurrentModelTurn(state: KernelState, payload: Record<string, JsonValue>): boolean {
  const turn = modelTurn(payload);
  return Boolean(turn && state.activeModelTurn
    && turn.turnId === state.activeModelTurn.turnId
    && turn.effectRevision === state.activeModelTurn.effectRevision);
}

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
  return { ...state, phase: "model_in_flight", activeModelTurn: turn };
};

const modelCompleted: EventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)) return state;
  const message = modelMessage(payload.message);
  const messages = message ? [...state.messages, message] : state.messages;
  const calls = modelToolCalls(payload.toolCalls);
  const modelTurn = state.activeModelTurn!;
  const completedState = { ...state, activeModelTurn: undefined };
  if (calls.length === 0) return incompleteCompletion(completedState, payload, messages);
  const pendingTools = pendingFromCalls(calls, modelTurn);
  return { ...completedState, messages, pendingTools, phase: "tool_pending" };
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
  const pending = pendingForEvent(state, payload);
  if (!pending) return state;
  const allowed = payload.decision === "allow" || payload.decision === "always_allow";
  const pendingTools = state.pendingTools.map((item) => item === pending
    ? { ...item, approval: allowed ? "allowed" as const : "denied" as const }
    : item);
  return { ...state, pendingTools, phase: nextPhase(pendingTools), outcome: undefined };
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
    evidence: receipt.ok ? [...state.evidence, event.payload] : state.evidence,
    phase: nextPhase(pendingTools)
  };
  const summary = completionSummary(receipt);
  return summary ? propose(next, { kind: "completed", message: summary, evidence: next.evidence }) : next;
};

const runSuspended: EventReducer = (state, _event, payload) => {
  if (text(payload.callId) && !pendingForEvent(state, payload)) return state;
  return {
    ...state,
    phase: "needs_input",
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

const runCompleted: EventReducer = (state, _event, payload) => acceptsOutcomeRevision(state, payload)
  ? terminal(state, { kind: "completed", message: text(payload.message), evidence: state.evidence })
  : state;

const diagnostic: EventReducer = (state, _event, payload) => {
  // user.steer is the durable authority for superseding a turn. The later
  // steering.restart event is observational only: applying it could erase a
  // newer turn that completed while the cancelled provider was unwinding.
  if (payload.kind === "steering.restart") return state;
  if (payload.kind === "recovery.retry_model") return { ...state, phase: "ready_model", activeModelTurn: undefined, outcome: undefined };
  if (payload.kind === "child.join_failed") {
    const failures = Array.isArray(payload.failures) ? payload.failures.filter((item): item is string => typeof item === "string") : [];
    return {
      ...state,
      phase: "ready_model",
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
  diagnostic
};

export function evolve(previous: KernelState, event: AgentEventEnvelope): KernelState {
  if (event.sessionId !== previous.sessionId) throw new Error("Kernel event session mismatch.");
  if (event.seq <= previous.lastSeq) throw new Error(`Kernel event sequence must increase: ${event.seq} <= ${previous.lastSeq}`);
  if (previous.phase === "terminal") return previous;
  const state: KernelState = { ...previous, revision: previous.revision + 1, lastSeq: event.seq };
  const reducer = reducers[event.type];
  return reducer ? reducer(state, event, objectPayload(event.payload)) : state;
}
