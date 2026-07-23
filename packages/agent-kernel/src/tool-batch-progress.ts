import type { KernelState } from "./state.js";
import {
  completeActionBatch,
  recordToolPolicyViolation,
  startActionBatch
} from "./task-control.js";

export function startedToolBatchProgress(state: KernelState): Pick<KernelState, "taskControl"> {
  return { taskControl: startActionBatch(state.taskControl) };
}

export function completedToolBatchProgress(state: KernelState): Pick<KernelState, "taskControl"> {
  let taskControl = completeActionBatch(state.taskControl, state.revision);
  const calls = [...state.messages].reverse().find((message) => message.role === "assistant"
    && message.toolCalls?.some((call) => state.receipts.some((receipt) => receipt.callId === call.id)))?.toolCalls ?? [];
  const receipts = new Map(state.receipts.map((receipt) => [receipt.callId, receipt]));
  const batchSucceeded = calls.length > 0
    && calls.every((call) => receipts.get(call.id)?.ok === true);
  const policyFailures = calls.flatMap((call) => {
    const receipt = receipts.get(call.id);
    const codes = receipt ? [...new Set([...(receipt.outcome?.diagnosticCodes ?? []), ...receipt.diagnostics])] : [];
    return codes.some((code) => code === "model_tool_policy_violation" || code === "tool_unavailable_for_repair")
      ? [call.name] : [];
  });
  // One rejected model batch is one correction attempt, independent of how
  // many calls the provider placed in that batch.
  if (policyFailures.length > 0) {
    taskControl = recordToolPolicyViolation(
      taskControl,
      "model_tool_policy_violation",
      state.revision
    );
  } else if (batchSucceeded
    && taskControl.policyCorrection && taskControl.policyCorrection.attempts < 2) {
    // A compliant batch accepts the runtime's correction even when its
    // read-only receipt does not create a new semantic fact. Only consecutive
    // rejected batches should exhaust the correction budget.
    taskControl = { ...taskControl, policyCorrection: undefined };
  }
  return { taskControl };
}
