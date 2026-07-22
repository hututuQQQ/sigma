import { createHash } from "node:crypto";
import type { EvidenceRecord } from "agent-protocol";
import type { KernelState } from "./state.js";
import type { TaskControlStateV1 } from "./task-control-state.js";
import {
  openTaskObligation,
  resolveTaskObligation,
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
  transactionId?: string
): TaskControlStateV1 {
  const basisDigest = repositoryBasisDigest({
    kind: "repository_recovery",
    goalEpoch: control.goalEpoch,
    stage,
    basis,
    transactionId: transactionId ?? null
  });
  return openTaskObligation(control, {
    kind: "repository_recovery",
    stage,
    basisDigest,
    openedRevision: revision,
    attempts: 0,
    ...(transactionId ? { transactionId } : {})
  });
}

export function advanceRepositoryEvidenceObligation(
  state: KernelState,
  evidence: EvidenceRecord
): KernelState | undefined {
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
        }
      )
    };
  }
  if (evidence.kind === "repository_acceptance"
    && evidence.data.goalEpoch === state.taskControl.goalEpoch
    && evidence.data.frontierRevision === state.mutationFrontier.revision
    && evidence.data.frontierStateDigest === state.mutationFrontier.currentStateDigest) {
    return { ...state, taskControl: resolveTaskObligation(state.taskControl) };
  }
  return undefined;
}

export function repositoryRecoveryDecisionState(
  state: KernelState,
  diagnostics: readonly string[]
): KernelState {
  if (diagnostics.includes("repository_restored")) {
    return { ...state, taskControl: resolveTaskObligation(state.taskControl) };
  }
  if (diagnostics.includes("conflicts_pending")) {
    return {
      ...state,
      taskControl: repositoryRecoveryObligation(
        state.taskControl,
        state.revision,
        "transact",
        { conflict: "pending" }
      )
    };
  }
  if (!diagnostics.includes("recovery_result_lost_no_replay")) return state;
  return {
    ...state,
    taskControl: userDecisionObligation(
      state.taskControl,
      state.revision,
      "recovery_result_lost_no_replay"
    )
  };
}
