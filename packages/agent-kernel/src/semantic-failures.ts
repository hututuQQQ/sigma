import {
  INFRASTRUCTURE_FAILURE_LIMIT,
  classifyInfrastructureFailureCodesV1,
  type EvidenceRecord,
  type InfrastructureFailureClassificationV1,
  type ToolReceipt,
  type WorkspaceDelta
} from "agent-protocol";
import type {
  KernelState,
  SemanticFailureCluster,
  SemanticProgressWatermark
} from "./state.js";

export const SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT = INFRASTRUCTURE_FAILURE_LIMIT;
export const SEMANTIC_INFRASTRUCTURE_FAILURE_CODE = "tool_infrastructure_failure_loop";

export interface SemanticFailureUpdate {
  state: KernelState;
  limitReached: boolean;
}

function classifyFailure(receipt: ToolReceipt): InfrastructureFailureClassificationV1 | undefined {
  if (receipt.ok) return undefined;
  return classifyInfrastructureFailureCodesV1([
    ...(receipt.outcome?.diagnosticCodes ?? []),
    ...receipt.diagnostics
  ]);
}

function deltaSize(delta: WorkspaceDelta | undefined): number {
  return (delta?.added.length ?? 0) + (delta?.modified.length ?? 0) + (delta?.deleted.length ?? 0);
}

function advancedProgress(
  progress: SemanticProgressWatermark,
  revision: number,
  workspaceChanges: number,
  durableEvidence: number
): SemanticProgressWatermark {
  return {
    workspaceChanges: progress.workspaceChanges + workspaceChanges,
    durableEvidence: progress.durableEvidence + durableEvidence,
    revision
  };
}

function progressMatches(left: SemanticProgressWatermark, right: SemanticProgressWatermark): boolean {
  return left.workspaceChanges === right.workspaceChanges
    && left.durableEvidence === right.durableEvidence
    && left.revision === right.revision;
}

function nextCluster(
  current: SemanticFailureCluster | undefined,
  classification: InfrastructureFailureClassificationV1,
  progress: SemanticProgressWatermark,
  revision: number
): SemanticFailureCluster {
  if (!current || current.family !== classification.family || !progressMatches(current.progress, progress)) {
    return {
      family: classification.family,
      attempts: 1,
      firstRevision: revision,
      lastRevision: revision,
      diagnosticCodes: classification.codes,
      progress: { ...progress }
    };
  }
  return {
    ...current,
    attempts: current.attempts + 1,
    lastRevision: revision,
    diagnosticCodes: [...new Set([...current.diagnosticCodes, ...classification.codes])]
  };
}

export function recordSemanticToolResult(state: KernelState, receipt: ToolReceipt): SemanticFailureUpdate {
  const workspaceChanges = deltaSize(receipt.workspaceDelta);
  if (workspaceChanges > 0) {
    return {
      state: {
        ...state,
        semanticProgress: advancedProgress(state.semanticProgress, state.revision, workspaceChanges, 0),
        semanticFailureCluster: undefined
      },
      limitReached: false
    };
  }
  if ((state.semanticFailureCluster?.attempts ?? 0) >= SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT) {
    return { state, limitReached: true };
  }
  const classification = classifyFailure(receipt);
  if (!classification) {
    return {
      state,
      limitReached: (state.semanticFailureCluster?.attempts ?? 0) >= SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT
    };
  }
  const cluster = nextCluster(state.semanticFailureCluster, classification, state.semanticProgress, state.revision);
  return {
    state: { ...state, semanticFailureCluster: cluster },
    limitReached: cluster.attempts >= SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT
  };
}

export function recordSemanticEvidenceProgress(state: KernelState, evidence: EvidenceRecord): KernelState {
  if (evidence.status === "failed") return state;
  const evidenceFromFailedTool = evidence.producer.authority === "tool"
    && state.receipts.some((receipt) => receipt.callId === evidence.producer.id && !receipt.ok);
  if (evidenceFromFailedTool) return state;
  const clearsPendingFailure = state.phase === "outcome_pending"
    && state.proposedOutcome?.kind === "recoverable_failure"
    && state.proposedOutcome.code === SEMANTIC_INFRASTRUCTURE_FAILURE_CODE;
  return {
    ...state,
    semanticProgress: advancedProgress(state.semanticProgress, state.revision, 0, 1),
    semanticFailureCluster: undefined,
    ...(clearsPendingFailure ? { phase: "ready_model" as const, proposedOutcome: undefined } : {})
  };
}

export function recordSemanticWorkspaceRestore(state: KernelState): KernelState {
  return {
    ...state,
    semanticProgress: advancedProgress(state.semanticProgress, state.revision, 1, 0),
    semanticFailureCluster: undefined
  };
}
