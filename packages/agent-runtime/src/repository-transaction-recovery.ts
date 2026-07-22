import path from "node:path";
import type { ProcessExecutionPort } from "agent-platform";
import type { ToolPreparationContext } from "agent-protocol";
import {
  collectRepositoryInspectionV2,
  repositoryInspectionTopologyCandidate,
  type PlannedToolExecutionContext,
  type RepositoryRecoverySelectionStore,
  type RepositoryWorktreeTopology
} from "agent-tools";
import type { GitOperation, GitTransactionInput } from "./repository-transaction-schema.js";

export interface RecoveryBinding {
  candidateId: string;
  selectionEvidenceId: string;
  selectedObject: string;
  selectedSymbolicRef: string | null;
}

function requireRecoverySelection(
  input: GitTransactionInput,
  context: Pick<ToolPreparationContext, "sessionId" | "runId" | "goalEpoch">,
  repositoryRoot: string,
  store?: RepositoryRecoverySelectionStore
) {
  if (!store || context.goalEpoch === undefined
    || !input.candidateId || !input.selectionEvidenceId) {
    throw Object.assign(new Error(
      "Repository recovery requires current runtime-issued selection evidence."
    ), { code: "repository_recovery_selection_invalid" });
  }
  return store.resolve(input.selectionEvidenceId, {
    sessionId: context.sessionId,
    runId: context.runId,
    goalEpoch: context.goalEpoch,
    repositoryRoot,
    candidateId: input.candidateId
  });
}

export function assertRecoverySelectionPlan(
  input: GitTransactionInput,
  context: ToolPreparationContext,
  repositoryRoot: string,
  store?: RepositoryRecoverySelectionStore
): void {
  if (input.action !== "recover") return;
  requireRecoverySelection(input, context, repositoryRoot, store);
}

export async function recoveryOperation(
  execution: ProcessExecutionPort,
  context: PlannedToolExecutionContext,
  input: GitTransactionInput,
  topology: RepositoryWorktreeTopology,
  store?: RepositoryRecoverySelectionStore
): Promise<{ operation: GitOperation; binding: RecoveryBinding }> {
  const selected = requireRecoverySelection(
    input, context, topology.worktreeRoot, store
  );
  const currentTopology = await repositoryInspectionTopologyCandidate({
    ...context,
    workspacePath: topology.worktreeRoot
  });
  if (path.resolve(currentTopology.worktreeRoot) !== path.resolve(topology.worktreeRoot)) {
    throw Object.assign(new Error(
      "Repository recovery selection was issued for a different repository root."
    ), { code: "repository_recovery_selection_stale" });
  }
  const current = await collectRepositoryInspectionV2(execution, currentTopology, context.signal);
  const evidence = selected.evidence.data;
  const candidate = current.recoveryCandidates.find((item) =>
    item.candidateId === input.candidateId && item.object === selected.selectedObject);
  if (!current.complete || !candidate
    || current.basisDigest !== evidence.inspectionBasisDigest
    || current.head !== evidence.inspectedHead
    || current.symbolicRef !== evidence.inspectedSymbolicRef
    || current.status.digest !== evidence.statusDigest
    || current.refs.digest !== evidence.refsDigest
    || current.reflog.digest !== evidence.reflogDigest) {
    throw Object.assign(new Error(
      "Repository state changed after recovery selection; inspect again before recovery."
    ), { code: "repository_recovery_selection_stale" });
  }
  return {
    operation: { op: "reset", mode: "hard", target: selected.selectedObject },
    binding: {
      candidateId: input.candidateId!,
      selectionEvidenceId: input.selectionEvidenceId!,
      selectedObject: selected.selectedObject,
      selectedSymbolicRef: current.symbolicRef
    }
  };
}
