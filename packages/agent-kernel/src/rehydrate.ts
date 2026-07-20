import {
  KERNEL_STATE_VERSION,
  isBudgetLedgerState,
  isCheckpointRef,
  isCompletionReferenceableEvidence,
  isEvidenceRecord,
  isPlanGraph,
  isUsageRecord,
  type AgentEventEnvelope
} from "agent-protocol";
import { evolve } from "./reducer.js";
import {
  isActiveModelTurn,
  isSemanticFailureCluster,
  isSemanticProgressWatermark,
  type KernelState
} from "./state.js";

export function rehydrate(initial: KernelState, events: Iterable<AgentEventEnvelope>): KernelState {
  let state = initial;
  for (const event of events) state = evolve(state, event);
  return state;
}

function assertDurableLedgers(state: KernelState): void {
  if (state.schemaVersion !== KERNEL_STATE_VERSION) throw new Error("Kernel state schema version mismatch.");
  if (!isPlanGraph(state.plan)) throw new Error("Kernel plan graph is invalid.");
  if (!isBudgetLedgerState(state.budget)) throw new Error("Kernel budget ledger is invalid.");
  if (state.checkpointHead && (!isCheckpointRef(state.checkpointHead)
    || state.checkpointHead.sessionId !== state.sessionId || state.checkpointHead.runId !== state.runId)) {
    throw new Error("Kernel checkpoint head is invalid for this session.");
  }
  assertEvidenceLedgers(state);
  if (!state.usage.every(isUsageRecord)) throw new Error("Kernel usage ledger contains an invalid record.");
  if (new Set(state.usage.map((item) => item.usageId)).size !== state.usage.length) {
    throw new Error("Duplicate kernel usage IDs.");
  }
  if (new Set(state.budget.reservations.map((item) => item.reservationId)).size !== state.budget.reservations.length) {
    throw new Error("Duplicate budget reservation IDs.");
  }
  assertSemanticFailureState(state);
}

function assertSemanticFailureState(state: KernelState): void {
  if (!isSemanticProgressWatermark(state.semanticProgress)
    || (state.semanticFailureCluster && !isSemanticFailureCluster(state.semanticFailureCluster))) {
    throw new Error("Kernel semantic failure progress state is invalid.");
  }
  const clusterProgress = state.semanticFailureCluster?.progress;
  if (clusterProgress && (clusterProgress.workspaceChanges !== state.semanticProgress.workspaceChanges
    || clusterProgress.durableEvidence !== state.semanticProgress.durableEvidence
    || clusterProgress.revision !== state.semanticProgress.revision)) {
    throw new Error("Kernel semantic failure cluster does not match its progress watermark.");
  }
  if (state.semanticProgress.revision > state.revision) {
    throw new Error("Kernel semantic progress revision exceeds the current revision.");
  }
  const cluster = state.semanticFailureCluster;
  if (cluster && (cluster.firstRevision > cluster.lastRevision || cluster.lastRevision > state.revision)) {
    throw new Error("Kernel semantic failure revisions are invalid.");
  }
}

function assertEvidenceLedgers(state: KernelState): void {
  if (!state.evidence.every(isEvidenceRecord)) throw new Error("Kernel evidence ledger contains an invalid record.");
  if (!state.mutationEvidence.every(isEvidenceRecord)) {
    throw new Error("Kernel mutation evidence ledger contains an invalid record.");
  }
  if (state.mutationEvidence.some((item) => item.sessionId !== state.sessionId)) {
    throw new Error("Kernel mutation evidence must belong to the active session.");
  }
  if (state.evidence.some((item) => item.sessionId !== state.sessionId || item.runId !== state.runId)) {
    throw new Error("Kernel evidence must belong to the active session and run.");
  }
  if (state.evidence.filter((item) => item.kind === "user_waiver").length > 1) {
    throw new Error("A run may contain at most one user waiver.");
  }
  if (new Set(state.evidence.map((item) => item.evidenceId)).size !== state.evidence.length) {
    throw new Error("Duplicate kernel evidence IDs.");
  }
  if (new Set(state.mutationEvidence.map((item) => item.evidenceId)).size !== state.mutationEvidence.length) {
    throw new Error("Duplicate kernel mutation evidence IDs.");
  }
}

function assertUniqueProcessIds(state: KernelState): void {
  if (new Set(state.activeProcessIds).size !== state.activeProcessIds.length) {
    throw new Error("Duplicate active process IDs.");
  }
}

function assertBudgetLimits(state: KernelState): void {
  for (const dimension of ["inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"] as const) {
    const active = state.budget.reservations
      .filter((reservation) => reservation.status === "reserved")
      .reduce((total, reservation) => total + reservation.requested[dimension], 0);
    if (active !== state.budget.reserved[dimension]) {
      throw new Error(`Budget dimension '${dimension}' does not match its active reservations.`);
    }
  }
}

function assertToolLedger(state: KernelState): void {
  const callIds = state.pendingTools.map((item) => item.request.callId);
  if (new Set(callIds).size !== callIds.length) throw new Error("Duplicate pending tool call IDs.");
  if (new Set(state.toolCallIds).size !== state.toolCallIds.length) throw new Error("Duplicate run tool call IDs.");
  if (state.pendingTools.some((item) => !isActiveModelTurn(item.modelTurn))) {
    throw new Error("Pending tools require a valid originating model turn.");
  }
  if (callIds.some((callId) => !state.toolCallIds.includes(callId))) {
    throw new Error("Every pending tool call must be present in the run tool-call ledger.");
  }
}

function assertRepairAttemptState(state: KernelState): void {
  const repair = state.completionRepair;
  if (!repair) {
    if (state.completionRepairAttempts !== 0) {
      throw new Error("Completion repair attempts require explicit repair state.");
    }
    return;
  }
  if (repair.kind === "protected_recovery") {
    if (state.completionRepairAttempts !== 0) {
      throw new Error("Protected completion recovery cannot consume a protocol-repair attempt.");
    }
  } else if (state.completionRepairAttempts === 0) {
    throw new Error("Explicit protocol-repair state requires a repair attempt.");
  }
}

function assertProtectedInputState(state: KernelState): void {
  if (state.phase !== "needs_input" && state.outcome?.kind !== "needs_input") return;
  const requestId = state.outcome?.kind === "needs_input" ? state.outcome.requestId : null;
  const approval = state.pendingTools.some((item) =>
    item.approval === "pending" && (requestId === null || item.request.callId === requestId));
  if (!approval) {
    throw new Error("A protected completion state can await input only for a pending tool approval.");
  }
}

function assertProtectedCompletionEvidence(state: KernelState): void {
  if (state.completionRepair?.kind === "no_change_confirmation") return;
  if (state.evidence.some((item) =>
    isCompletionReferenceableEvidence(item, state.sessionId, state.runId))) return;
  throw new Error("A protected completion repair requires current-run referenceable evidence.");
}

function assertSinglePendingTool(
  state: KernelState,
  allowedNames: readonly string[],
  message: string
): void {
  if (state.pendingTools.length === 0) return;
  const terminalName = state.pendingTools[0]!.request.name;
  if (state.pendingTools.length === 1 && allowedNames.includes(terminalName)) return;
  throw new Error(message);
}

function assertProtectedRepairState(
  state: KernelState,
  repair: NonNullable<KernelState["completionRepair"]>
): void {
  const protectedAnswer = repair.kind === "no_change_confirmation"
    || repair.kind === "protected_completion"
    || repair.kind === "protected_recovery";
  if (!protectedAnswer) return;
  assertProtectedCompletionEvidence(state);
  if (repair.kind === "protected_completion") {
    assertSinglePendingTool(state, ["runtime_finalize", "request_user_input"],
      "A protected terminal-intent repair can pend only one runtime completion intent or request_user_input call.");
  }
  if (repair.kind === "no_change_confirmation") {
    assertSinglePendingTool(state, ["confirm_no_change", "request_user_input", "report_blocked"],
      "A no-change confirmation can pend only one typed terminal-intent call.");
  }
  assertProtectedInputState(state);
}

function assertCompletionRepairState(state: KernelState): void {
  assertRepairAttemptState(state);
  if (state.completionRepair) assertProtectedRepairState(state, state.completionRepair);
}

function assertPhaseState(state: KernelState): void {
  if ((state.phase === "model_in_flight") !== Boolean(state.activeModelTurn)) {
    throw new Error("Model-in-flight state and active model turn must agree.");
  }
  if (state.activeModelTurn && !isActiveModelTurn(state.activeModelTurn)) {
    throw new Error("Active model turn policy is invalid.");
  }
  if (state.activeModelSemanticDelta && state.phase !== "model_in_flight") {
    throw new Error("A durable model semantic delta requires an active model turn.");
  }
  if (state.phase === "terminal" && !state.outcome) throw new Error("Terminal kernel state requires an outcome.");
  if (state.phase !== "terminal" && state.outcome?.kind !== "needs_input") {
    if (state.outcome) throw new Error("Non-terminal kernel state cannot have a terminal outcome.");
  }
  assertCompletionRepairState(state);
}

export function assertKernelInvariants(state: KernelState): void {
  assertDurableLedgers(state);
  assertUniqueProcessIds(state);
  assertBudgetLimits(state);
  assertToolLedger(state);
  assertPhaseState(state);
}
