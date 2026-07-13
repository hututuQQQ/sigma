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

/**
 * Built-in tools whose successful receipt proves that a new process was
 * launched. Other process tools share the process.spawn.readonly effect for
 * policy purposes, but polling, writing to, or terminating an existing handle
 * is not execution-infrastructure recovery.
 */
const PROCESS_LAUNCH_TOOL_NAMES = new Set(["exec", "shell", "validate", "process_spawn"]);

function isExecutionInfrastructureCluster(cluster: SemanticFailureCluster | undefined): boolean {
  return cluster?.family.startsWith("execution_") === true;
}

export function semanticInfrastructureFailureMessage(cluster: SemanticFailureCluster): string {
  const recoveryBoundary = isExecutionInfrastructureCluster(cluster)
    ? "a successful process launch"
    : "workspace or durable evidence progress";
  return `Infrastructure repeatedly failed without ${recoveryBoundary} (${cluster.family}, ${cluster.attempts} attempts; diagnostics: ${cluster.diagnosticCodes.join(", ")}).`;
}

function successfulProcessLaunch(receipt: ToolReceipt, toolName: string): boolean {
  if (!receipt.ok || !PROCESS_LAUNCH_TOOL_NAMES.has(toolName)) return false;
  // An explicitly empty V3 actual-effects projection is authoritative. Only
  // legacy receipts that omit it may fall back to the V2 observed projection.
  const effects = receipt.actualEffects === undefined ? receipt.observedEffects : receipt.actualEffects;
  return effects.some((effect) => effect === "process.spawn" || effect === "process.spawn.readonly");
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

function withWorkspaceProgress(
  state: KernelState,
  workspaceChanges: number,
  preserveExecutionCluster: boolean
): KernelState {
  if (workspaceChanges === 0) return state;
  const semanticProgress = advancedProgress(state.semanticProgress, state.revision, workspaceChanges, 0);
  return {
    ...state,
    semanticProgress,
    semanticFailureCluster: preserveExecutionCluster && state.semanticFailureCluster
      ? { ...state.semanticFailureCluster, progress: semanticProgress }
      : undefined
  };
}

export function recordSemanticToolResult(
  state: KernelState,
  receipt: ToolReceipt,
  toolName: string
): SemanticFailureUpdate {
  const workspaceChanges = deltaSize(receipt.workspaceDelta);
  const executionCluster = isExecutionInfrastructureCluster(state.semanticFailureCluster);
  if (successfulProcessLaunch(receipt, toolName)) {
    return {
      state: withWorkspaceProgress({ ...state, semanticFailureCluster: undefined }, workspaceChanges, false),
      limitReached: false
    };
  }
  if (workspaceChanges > 0 && !executionCluster) {
    return { state: withWorkspaceProgress(state, workspaceChanges, false), limitReached: false };
  }
  const progressed = withWorkspaceProgress(state, workspaceChanges, executionCluster);
  if ((progressed.semanticFailureCluster?.attempts ?? 0) >= SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT) {
    return { state: progressed, limitReached: true };
  }
  const classification = classifyFailure(receipt);
  if (!classification) {
    return {
      state: progressed,
      limitReached: (progressed.semanticFailureCluster?.attempts ?? 0) >= SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT
    };
  }
  const cluster = nextCluster(
    progressed.semanticFailureCluster,
    classification,
    progressed.semanticProgress,
    progressed.revision
  );
  return {
    state: { ...progressed, semanticFailureCluster: cluster },
    limitReached: cluster.attempts >= SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT
  };
}

export function recordSemanticEvidenceProgress(state: KernelState, evidence: EvidenceRecord): KernelState {
  if (evidence.status === "failed") return state;
  const evidenceFromFailedTool = evidence.producer.authority === "tool"
    && state.receipts.some((receipt) => receipt.callId === evidence.producer.id && !receipt.ok);
  if (evidenceFromFailedTool) return state;
  const executionCluster = isExecutionInfrastructureCluster(state.semanticFailureCluster);
  const clearsPendingFailure = !executionCluster && state.phase === "outcome_pending"
    && state.proposedOutcome?.kind === "recoverable_failure"
    && state.proposedOutcome.code === SEMANTIC_INFRASTRUCTURE_FAILURE_CODE;
  const semanticProgress = advancedProgress(state.semanticProgress, state.revision, 0, 1);
  return {
    ...state,
    semanticProgress,
    semanticFailureCluster: executionCluster && state.semanticFailureCluster
      ? { ...state.semanticFailureCluster, progress: semanticProgress }
      : undefined,
    ...(clearsPendingFailure ? { phase: "ready_model" as const, proposedOutcome: undefined } : {})
  };
}

export function recordSemanticWorkspaceRestore(state: KernelState): KernelState {
  const executionCluster = isExecutionInfrastructureCluster(state.semanticFailureCluster);
  const semanticProgress = advancedProgress(state.semanticProgress, state.revision, 1, 0);
  return {
    ...state,
    semanticProgress,
    semanticFailureCluster: executionCluster && state.semanticFailureCluster
      ? { ...state.semanticFailureCluster, progress: semanticProgress }
      : undefined
  };
}
