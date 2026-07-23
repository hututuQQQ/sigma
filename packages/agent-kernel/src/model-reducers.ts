import type {
  AgentEventType,
  JsonValue,
  ModelMessage
} from "agent-protocol";
import type { KernelEventReducer } from "./durable-reducers.js";
import {
  isCurrentModelTurn,
  modelMessage,
  modelToolCalls,
  modelTurn
} from "./model-event-parsing.js";
import {
  pendingFromCalls,
  proposedOutcomeState,
  text
} from "./reducer-helpers.js";
import type { KernelState } from "./state.js";

export const resetModelCompletion = {
  lastModelFinishReason: undefined,
  consecutiveLengthFinishes: 0,
  consecutiveLengthNoAction: 0,
  lastModelHadToolCalls: false
} as const;

const modelStarted: KernelEventReducer = (state, _event, payload) => {
  const turn = modelTurn(payload);
  if (state.phase !== "ready_model" || !turn || turn.effectRevision !== state.revision - 1) return state;
  return { ...state, phase: "model_in_flight", activeModelTurn: turn, activeModelSemanticDelta: false };
};

const modelSemanticDelta: KernelEventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !state.activeModelTurn
    || payload.turnId !== state.activeModelTurn.turnId) return state;
  return { ...state, activeModelSemanticDelta: true };
};

const promptMaterialized: KernelEventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)
    || !Array.isArray(payload.messages)) return state;
  const messages = payload.messages
    .map((item) => modelMessage(item))
    .filter((item): item is ModelMessage => item !== null);
  if (messages.length !== payload.messages.length) return state;
  return { ...state, messages: [...state.messages, ...messages] };
};

export function lengthContinuationMessage(withTools: boolean): ModelMessage {
  return {
    role: "developer",
    content: withTools
      ? "The preceding assistant turn reached its output limit after issuing tool calls. The calls were executed exactly once. Continue from their receipts, avoid repeating settled work, and make the next turn action-oriented."
      : "The preceding assistant turn reached its output limit without issuing a tool call. Continue from the partial work without repeating settled reasoning, and make the next turn action-oriented by using an appropriate tool or delivering the smallest complete answer."
  };
}

function stoppedOutcome(
  state: KernelState,
  payload: Record<string, JsonValue>,
  messages: ModelMessage[],
  message: ModelMessage | null
): KernelState {
  const finishReason = text(payload.finishReason);
  const answer = message?.content.trim() ?? "";
  if (finishReason === "length" && state.consecutiveLengthNoAction < 3) {
    return {
      ...state,
      phase: "ready_model",
      messages: [...messages, lengthContinuationMessage(false)],
      proposedOutcome: undefined,
      outcome: undefined
    };
  }
  if (finishReason !== "stop") {
    return proposedOutcomeState({ ...state, messages }, {
      kind: "recoverable_failure",
      code: finishReason === "length" ? "model_output_truncated" : "model_protocol_error",
      message: finishReason === "length"
        ? "The model exhausted its output allowance before reaching a natural stop."
        : `The model returned no tool calls with finish reason '${finishReason || "unknown"}'.`
    });
  }
  if (!answer) {
    return proposedOutcomeState({ ...state, messages }, {
      kind: "recoverable_failure",
      code: "empty_assistant_response",
      message: "The model stopped without a user-visible response or a tool call."
    });
  }
  return proposedOutcomeState({ ...state, messages }, {
    kind: "completed",
    message: answer,
    evidence: state.evidence
  });
}

const modelCompleted: KernelEventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)) return state;
  const message = modelMessage(payload.message);
  const messages = message ? [...state.messages, message] : state.messages;
  const calls = modelToolCalls(payload.toolCalls);
  const turn = state.activeModelTurn!;
  const finishReason = text(payload.finishReason);
  const length = finishReason === "length";
  const completedState: KernelState = {
    ...state,
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    lastModelFinishReason: finishReason === "stop" || finishReason === "length"
      || finishReason === "tool_calls" || finishReason === "content_filter"
      || finishReason === "protocol_error"
      ? finishReason
      : undefined,
    consecutiveLengthFinishes: length ? state.consecutiveLengthFinishes + 1 : 0,
    consecutiveLengthNoAction: length && calls.length === 0
      ? state.consecutiveLengthNoAction + 1
      : 0,
    lastModelHadToolCalls: calls.length > 0
  };
  if (calls.length === 0) return stoppedOutcome(completedState, payload, messages, message);
  const identifiers = calls.map((call) => call.id);
  const seen = new Set(state.toolCallIds);
  const duplicate = identifiers.find((id, index) =>
    identifiers.indexOf(id) !== index || seen.has(id));
  if (duplicate) {
    return proposedOutcomeState({ ...completedState, messages }, {
      kind: "recoverable_failure",
      code: "protocol_error",
      message: `Model reused tool call id '${duplicate}' within the current run.`
    });
  }
  return {
    ...completedState,
    messages,
    pendingTools: pendingFromCalls(calls, turn),
    toolCallIds: [...state.toolCallIds, ...identifiers],
    phase: "tool_pending"
  };
};

const modelFailed: KernelEventReducer = (state, _event, payload) => {
  if (state.phase !== "model_in_flight" || !isCurrentModelTurn(state, payload)) return state;
  return proposedOutcomeState(state, {
    kind: "recoverable_failure",
    code: text(payload.code) || "model_error",
    message: text(payload.message) || "The model request failed."
  });
};

export const modelReducers: Partial<Record<AgentEventType, KernelEventReducer>> = {
  "model.started": modelStarted,
  "model.prompt_materialized": promptMaterialized,
  "model.delta": modelSemanticDelta,
  "model.reasoning_delta": modelSemanticDelta,
  "model.completed": modelCompleted,
  "model.failed": modelFailed
};
