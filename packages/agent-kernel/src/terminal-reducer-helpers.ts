import type { JsonValue, ModelToolCall, RunOutcome, ToolReceipt } from "agent-protocol";
import {
  completionRepairFailureMessage,
  completionSummary,
  failedTerminalRepairState,
  protectedCompletionAnswer,
  requestedInput
} from "./model-convergence.js";
import {
  semanticInfrastructureFailureMessage,
  SEMANTIC_INFRASTRUCTURE_FAILURE_CODE
} from "./semantic-failures.js";
import { isCurrentModelTurn, modelTurn } from "./model-event-parsing.js";
import type { KernelState, PendingTool } from "./state.js";

export function nextPhase(pending: readonly PendingTool[]): KernelState["phase"] {
  if (pending.some((item) => item.approval === "pending")) return "needs_input";
  if (pending.some((item) => item.started)) return "tool_in_flight";
  return pending.length > 0 ? "tool_pending" : "ready_model";
}

export function pendingForEvent(
  state: KernelState,
  payload: Record<string, JsonValue>
): PendingTool | undefined {
  const turn = modelTurn(payload);
  const callId = typeof payload.callId === "string" ? payload.callId : "";
  if (!turn || !callId) return undefined;
  return state.pendingTools.find((item) => item.request.callId === callId
    && item.modelTurn.turnId === turn.turnId
    && item.modelTurn.effectRevision === turn.effectRevision);
}

export function isRecoverySuspension(state: KernelState, payload: Record<string, JsonValue>): boolean {
  const checkpointRecovery = typeof payload.checkpointId === "string"
    && Array.isArray(payload.choices)
    && payload.choices.length === 2
    && payload.choices[0] === "restore"
    && payload.choices[1] === "keep";
  const processRecovery = Array.isArray(payload.processIds)
    && payload.processIds.length > 0
    && payload.processIds.every((item) => typeof item === "string" && item.length > 0);
  const interruptedModelRecovery = state.phase === "model_in_flight" && isCurrentModelTurn(state, payload);
  return checkpointRecovery || processRecovery || interruptedModelRecovery;
}

export function acceptsOutcomeRevision(state: KernelState, payload: Record<string, JsonValue>): boolean {
  if (payload.outcomeRevision === undefined) return true;
  return Number.isInteger(payload.outcomeRevision)
    && payload.outcomeRevision === state.revision - 1
    && state.phase === "outcome_pending";
}

export function terminalState(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "terminal",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    pendingTools: [],
    completionRepairAttempts: 0,
    completionRepair: undefined,
    proposedOutcome: undefined,
    outcome
  };
}

export function proposedOutcomeState(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "outcome_pending",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    proposedOutcome: outcome
  };
}

export function protectedToolBatchFailure(
  state: KernelState,
  calls: readonly ModelToolCall[]
): { code: "terminal_batch_conflict" | "terminal_protocol_invalid"; message: string } | null {
  if (state.completionRepair?.kind !== "protected_completion") return null;
  const terminal = calls[0]?.name === "complete_task" || calls[0]?.name === "request_user_input";
  if (calls.length === 1 && terminal) return null;
  const terminalCount = calls.filter((call) =>
    call.name === "complete_task" || call.name === "request_user_input").length;
  return calls.length > 1 && terminalCount > 0
    ? {
        code: "terminal_batch_conflict",
        message: "The protected terminal-intent repair mixed a terminal action with another call."
      }
    : {
        code: "terminal_protocol_invalid",
        message: "The protected terminal-intent repair did not choose exactly one complete_task or request_user_input call."
      };
}

function terminalReceiptFailure(
  state: KernelState,
  progressed: KernelState,
  toolName: string,
  action: "complete" | "request_input"
): KernelState | null {
  const expectedTool = action === "complete" ? "complete_task" : "request_user_input";
  if (toolName === expectedTool) return null;
  return proposedOutcomeState(progressed, {
    kind: "recoverable_failure",
    code: "terminal_protocol_invalid",
    message: completionRepairFailureMessage(
      state,
      `Only the standard ${expectedTool} tool may produce this terminal outcome.`
    )
  });
}

export interface TerminalReceiptTransition {
  state: KernelState;
  progressed: KernelState;
  receipt: ToolReceipt;
  toolName: string;
  remainingTools: number;
  repairPending: boolean;
  terminalRepairPending: boolean;
  semanticLimitReached: boolean;
}

export function terminalReceiptTransition(input: TerminalReceiptTransition): KernelState | null {
  const inputMessage = requestedInput(input.receipt);
  if (inputMessage) {
    const failure = terminalReceiptFailure(input.state, input.progressed, input.toolName, "request_input");
    if (failure) return failure;
    return proposedOutcomeState(input.progressed, {
      kind: "needs_input",
      requestId: input.receipt.callId,
      message: inputMessage
    });
  }
  const summary = completionSummary(input.receipt);
  if (summary) {
    const failure = terminalReceiptFailure(input.state, input.progressed, input.toolName, "complete");
    if (failure) return failure;
    return proposedOutcomeState(input.progressed, {
      kind: "completed",
      message: protectedCompletionAnswer(input.state) || summary,
      evidence: input.progressed.evidence
    });
  }
  const failedRepair = failedTerminalRepairState(
    input.progressed,
    input.repairPending,
    input.terminalRepairPending,
    input.receipt,
    input.remainingTools
  );
  if (failedRepair) return failedRepair;
  if (input.semanticLimitReached && input.remainingTools === 0 && input.progressed.semanticFailureCluster) {
    return proposedOutcomeState(input.progressed, {
      kind: "recoverable_failure",
      code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE,
      message: semanticInfrastructureFailureMessage(input.progressed.semanticFailureCluster)
    });
  }
  return null;
}
