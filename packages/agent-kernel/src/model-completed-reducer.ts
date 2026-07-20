import type { ModelMessage, ModelToolCall } from "agent-protocol";
import type { ActiveModelTurn, KernelState, PendingTool } from "./state.js";
import type { KernelEventReducer } from "./durable-reducers.js";
import {
  completionRepairFailureMessage,
  conflictingTerminalBatch,
  hasCompletionRepair,
  incompleteModelCompletion,
  repairConflictingTerminalBatch
} from "./model-convergence.js";
import { isCurrentModelTurn, modelMessage, modelToolCalls } from "./model-event-parsing.js";
import { repeatsCompletedToolBatch, semanticActionDebt } from "./tool-batch-progress.js";
import { protectedToolBatchFailure, proposedOutcomeState } from "./terminal-reducer-helpers.js";

function pendingFromCalls(calls: ModelToolCall[], modelTurn: ActiveModelTurn): PendingTool[] {
  return calls.map((call): PendingTool => ({
    request: { callId: call.id, name: call.name, arguments: call.arguments },
    modelTurn,
    approval: "not_required",
    started: false,
    origin: "model"
  }));
}

function convergenceRejectionMessages(
  calls: readonly ModelToolCall[],
  reason: "exact_duplicate" | "focused_action_required"
): ModelMessage[] {
  const explanation = reason === "exact_duplicate"
    ? "Rejected before execution because this exact tool batch was already completed without trusted semantic progress."
    : "Rejected before execution because convergence permits exactly one focused tool action.";
  return [
    ...calls.map((call): ModelMessage => ({
      role: "tool",
      toolCallId: call.id,
      content: `Failed tool receipt ID: ${call.id}\n${explanation}`
    })),
    {
      role: "developer",
      content: "[convergence_terminal] The focused convergence opportunity ended without trusted progress. The next turn is terminal-only: finalize the best supported result, report a durable blocker, or request concrete user input. Do not propose another ordinary tool action."
    }
  ];
}

function toolPolicyRejectionMessages(
  calls: readonly ModelToolCall[],
  allowedToolNames: readonly string[]
): ModelMessage[] {
  const offered = allowedToolNames.length > 0 ? allowedToolNames.join(", ") : "none";
  return [
    ...calls.map((call): ModelMessage => ({
      role: "tool",
      toolCallId: call.id,
      content: `Failed tool receipt ID: ${call.id}\nTool '${call.name}' was not authorized for its originating model turn and was not started.`
    })),
    {
      role: "developer",
      content: `[tool_policy_violation] The provider selected a tool outside the runtime-bound turn policy (offered: ${offered}). This is the one correction turn. Choose exactly one currently offered terminal action; do not retry an ordinary or mixed-effect tool.`
    }
  ];
}

function modelToolCallsAuthorized(
  modelTurn: ActiveModelTurn,
  calls: readonly ModelToolCall[]
): boolean {
  const policy = modelTurn.toolPolicy;
  return Boolean(policy && calls.every((call) => policy.allowedToolNames.includes(call.name)));
}

function rejectUnauthorizedToolBatch(
  state: KernelState,
  completedState: KernelState,
  messages: ModelMessage[],
  calls: readonly ModelToolCall[],
  identifiers: readonly string[]
): KernelState {
  const rejectionMessages = toolPolicyRejectionMessages(
    calls, state.activeModelTurn?.toolPolicy?.allowedToolNames ?? []
  );
  const rejectedState: KernelState = {
    ...completedState,
    messages: [...messages, ...rejectionMessages],
    toolCallIds: [...state.toolCallIds, ...identifiers]
  };
  if (state.completionRepairAttempts >= 1) {
    return proposedOutcomeState(rejectedState, {
      kind: "recoverable_failure",
      code: "model_tool_policy_violation",
      message: completionRepairFailureMessage(
        state,
        "The provider selected a tool outside the runtime-bound turn policy after its one correction turn."
      )
    });
  }
  return {
    ...rejectedState,
    completionRepairAttempts: 1,
    completionRepair: { kind: "terminal_action" },
    repeatedToolBatchCount: Math.max(3, semanticActionDebt(state) + 1),
    continuationAttempts: 0,
    phase: "ready_model"
  };
}

export const modelCompleted: KernelEventReducer = (state, _event, payload) => {
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
  if (!modelToolCallsAuthorized(modelTurn, calls)) {
    return rejectUnauthorizedToolBatch(state, completedState, messages, calls, identifiers);
  }
  const actionDebt = semanticActionDebt(state);
  const repeatedBatch = repeatsCompletedToolBatch(state, calls);
  const unfocusedConvergenceBatch = actionDebt >= 2 && calls.length > 1;
  if (repeatedBatch || unfocusedConvergenceBatch) {
    return {
      ...completedState,
      messages: [
        ...messages,
        ...convergenceRejectionMessages(
          calls,
          repeatedBatch ? "exact_duplicate" : "focused_action_required"
        )
      ],
      toolCallIds: [...state.toolCallIds, ...identifiers],
      repeatedToolBatchCount: Math.max(3, actionDebt + 1),
      continuationAttempts: 0,
      phase: "ready_model"
    };
  }
  if (conflictingTerminalBatch(calls, hasCompletionRepair(state))) {
    return repairConflictingTerminalBatch({ ...completedState, messages }, messages);
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
