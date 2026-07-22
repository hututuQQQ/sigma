import { createHash } from "node:crypto";
import type { EvidenceRecord, JsonValue, ToolReceipt } from "agent-protocol";
import type { KernelState } from "./state.js";
import type { TaskControlStateV1 } from "./task-control-state.js";
import {
  openTaskObligation,
  resolveTaskObligation,
  terminalResolutionObligation,
  userDecisionObligation
} from "./task-control.js";

function repositoryBasisDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function repositoryRecoveryObligation(
  control: TaskControlStateV1,
  revision: number,
  stage: "inspect" | "select" | "transact" | "validate",
  basis: unknown,
  details: {
    transactionId?: string;
    candidateId?: string;
    selectionEvidenceId?: string;
    scopePaths?: string[];
  } = {}
): TaskControlStateV1 {
  const basisDigest = repositoryBasisDigest({
    kind: "repository_recovery",
    goalEpoch: control.goalEpoch,
    stage,
    basis,
    details
  });
  return openTaskObligation(control, {
    kind: "repository_recovery",
    stage,
    basisDigest,
    openedRevision: revision,
    attempts: 0,
    ...details
  });
}

/** A response to a runtime-owned repository choice continues the same goal
 * epoch. Treating it as a new user goal would immediately invalidate the
 * inspection evidence the user is answering. */
export function resumeRepositoryRecoveryDecision(
  control: TaskControlStateV1,
  revision: number
): TaskControlStateV1 | undefined {
  const obligation = control.obligation;
  if (obligation?.kind !== "user_decision"
    || !obligation.decisionCode.startsWith("repository_recovery:")) return undefined;
  const candidateSetDigest = obligation.decisionCode.slice("repository_recovery:".length);
  if (!/^[a-f0-9]{64}$/u.test(candidateSetDigest)) return undefined;
  return repositoryRecoveryObligation(
    control,
    revision,
    "select",
    { candidateSetDigest, priorBasisDigest: obligation.basisDigest }
  );
}

function repositoryObligationCanAdvance(control: TaskControlStateV1): boolean {
  const obligation = control.obligation;
  return !obligation || obligation.kind === "repository_recovery";
}

export function advanceRepositoryEvidenceObligation(
  state: KernelState,
  evidence: EvidenceRecord
): KernelState | undefined {
  if (!repositoryObligationCanAdvance(state.taskControl)) return undefined;
  if (evidence.kind === "repository_recovery_decision"
    && evidence.data.goalEpoch === state.taskControl.goalEpoch) {
    return {
      ...state,
      taskControl: userDecisionObligation(
        state.taskControl,
        state.revision,
        `repository_recovery:${evidence.data.candidateSetDigest}`
      )
    };
  }
  if (evidence.kind === "repository_recovery_selection"
    && evidence.data.goalEpoch === state.taskControl.goalEpoch) {
    return {
      ...state,
      taskControl: repositoryRecoveryObligation(
        state.taskControl,
        state.revision,
        "transact",
        {
          candidateId: evidence.data.candidateId,
          selectionEvidenceId: evidence.evidenceId,
          inspectionBasisDigest: evidence.data.inspectionBasisDigest
        },
        {
          candidateId: evidence.data.candidateId,
          selectionEvidenceId: evidence.evidenceId
        }
      )
    };
  }
  if (state.taskControl.obligation?.kind === "repository_recovery"
    && evidence.kind === "repository_acceptance"
    && evidence.data.goalEpoch === state.taskControl.goalEpoch
    && evidence.data.frontierRevision === state.mutationFrontier.revision
    && evidence.data.frontierStateDigest === state.mutationFrontier.currentStateDigest) {
    return { ...state, taskControl: resolveTaskObligation(state.taskControl) };
  }
  return undefined;
}

function resultObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : {};
}

function resultPaths(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function pendingConflictState(
  state: KernelState,
  receipt: ToolReceipt
): KernelState | undefined {
  if (!receipt.diagnostics.includes("conflicts_pending")) return undefined;
  const obligation = state.taskControl.obligation;
  const result = resultObject(receipt.result);
  const transactionId = typeof result.transactionHandle === "string"
    ? result.transactionHandle : undefined;
  const scopePaths = resultPaths(result.conflictPaths);
  if (!transactionId || scopePaths.length === 0) {
    return {
      ...state,
      taskControl: terminalResolutionObligation(
        state.taskControl,
        state.revision,
        "repository_state_uncertain"
      )
    };
  }
  return {
    ...state,
    taskControl: repositoryRecoveryObligation(
      state.taskControl,
      state.revision,
      "transact",
      { conflict: "pending", transactionId, scopePaths },
      {
        transactionId,
        scopePaths,
        ...(obligation?.kind === "repository_recovery" && obligation.candidateId
          ? { candidateId: obligation.candidateId } : {}),
        ...(obligation?.kind === "repository_recovery" && obligation.selectionEvidenceId
          ? { selectionEvidenceId: obligation.selectionEvidenceId } : {})
      }
    )
  };
}

export function repositoryRecoveryDecisionState(
  state: KernelState,
  toolName: string,
  receipt: ToolReceipt
): KernelState {
  if (receipt.diagnostics.includes("recovery_result_lost_no_replay")) {
    return {
      ...state,
      taskControl: userDecisionObligation(
        state.taskControl,
        state.revision,
        "recovery_result_lost_no_replay"
      )
    };
  }
  if (toolName !== "git_transaction") return state;
  const obligation = state.taskControl.obligation;
  if (receipt.diagnostics.includes("repository_restored")
    && obligation?.kind === "repository_recovery") {
    return { ...state, taskControl: resolveTaskObligation(state.taskControl) };
  }
  const conflict = pendingConflictState(state, receipt);
  if (conflict) return conflict;
  return state;
}
