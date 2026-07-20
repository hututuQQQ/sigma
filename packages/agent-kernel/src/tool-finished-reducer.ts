import type { JsonValue, ToolReceiptRuntimeAdvisoryV1 } from "agent-protocol";
import type { KernelEventReducer } from "./durable-reducers.js";
import { hasCompletionRepair, completionRepairRequiresTerminalAction } from "./model-convergence.js";
import { pendingForEvent, nextPhase, terminalReceiptTransition } from "./terminal-reducer-helpers.js";
import { receiptContent, toolReceipt } from "./receipt-parsing.js";
import { recordSemanticToolResult } from "./semantic-failures.js";
import { completedToolBatchProgress } from "./tool-batch-progress.js";
import type { KernelState } from "./state.js";

function objectPayload(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function noProgressAdvisory(repeatCount: number): ToolReceiptRuntimeAdvisoryV1 {
  return {
    schemaVersion: 1,
    code: "no_progress",
    repeatCount,
    unchangedDimensions: ["workspace", "validation_frontier", "process_state", "evidence"],
    repair: {
      kind: "change_action_or_converge",
      suggestions: ["change_tool_or_arguments", "repair_blocker", "validate_or_finish"]
    }
  };
}

function attachNoProgressAdvisory(state: KernelState, callId: string, repeatCount: number): KernelState {
  return {
    ...state,
    receipts: state.receipts.map((item) => item.callId === callId
      ? { ...item, runtimeAdvisories: [...(item.runtimeAdvisories ?? []), noProgressAdvisory(repeatCount)] }
      : item)
  };
}

export const toolFinished: KernelEventReducer = (state, event) => {
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
  const completedBatch = pendingTools.length === 0
    ? completedToolBatchProgress(next, receipt.callId)
    : undefined;
  const batchState = { ...next, ...(completedBatch ?? {}) };
  const warnedState = completedBatch?.repeatedToolBatchCount === 2
    ? (() => {
        const advisedState = attachNoProgressAdvisory(batchState, receipt.callId, completedBatch.repeatedToolBatchCount);
        return {
          ...advisedState,
          messages: [...advisedState.messages, {
            role: "developer" as const,
            content: "[no_progress] Tool actions have now completed twice without trusted workspace, newly accessed input, validation, review, process, plan, or checkpoint progress. Exactly one focused action remains before terminal-only convergence. Parameter, command-text, artifact-ID, or diagnostic-output variation is not progress; produce a trusted state change, repair the blocker, validate, or finish."
          }]
        };
      })()
    : batchState;
  const semantic = recordSemanticToolResult(
    warnedState,
    receipt,
    pending.request.name,
    pending.modelTurn.turnId
  );
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
