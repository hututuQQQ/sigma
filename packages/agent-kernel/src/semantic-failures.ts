import type { EvidenceRecord, ToolReceipt, WorkspaceDelta } from "agent-protocol";
import type {
  KernelState,
  SemanticFailureCluster,
  SemanticProgressWatermark
} from "./state.js";

export const SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT = 3;
export const SEMANTIC_INFRASTRUCTURE_FAILURE_CODE = "tool_infrastructure_failure_loop";

interface FailureClassification {
  family: string;
  diagnosticCodes: string[];
}

export interface SemanticFailureUpdate {
  state: KernelState;
  limitReached: boolean;
}

const CODE_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:workspace_transaction_root_unavailable|workspace_transaction_cleanup_failed|checkpoint_recovery_failed)$/u,
    "workspace_transaction"],
  [/^(?:broker_connection_error|broker_protocol_error|process_lost)$/u, "execution_broker"],
  [/^(?:sandbox_unavailable|sandbox_denied|sandbox_setup_failed|sandbox_self_test_failed)$/u, "execution_sandbox"],
  [/^(?:process_spawn_failed|spawn_failed|executable_not_found|executable_unavailable|shell_unavailable|runtime_unavailable|toolchain_unavailable)$/u,
    "execution_capability"],
  [/^(?:invalid_output_encoding|output_decode_error|output_encoding_unsupported)$/u, "execution_output_encoding"],
  [/^(?:broker_timeout|process_idle_timeout|process_deadline|process_timed_out)$/u, "execution_timeout"]
];

function normalizedCode(value: string): string {
  return value.trim().toLowerCase().split(":", 1)[0] ?? "";
}

function familyForCode(code: string): string | null {
  for (const [pattern, family] of CODE_FAMILIES) {
    if (pattern.test(code)) return family;
  }
  return null;
}

function classifyFailure(receipt: ToolReceipt): FailureClassification | null {
  if (receipt.ok) return null;
  const codes = [...new Set([
    ...(receipt.outcome?.diagnosticCodes ?? []),
    ...receipt.diagnostics
  ].map(normalizedCode).filter(Boolean))];
  const classified = codes.flatMap((code) => {
    const family = familyForCode(code);
    return family ? [{ code, family }] : [];
  });
  if (classified.length === 0) return null;
  const family = classified[0]!.family;
  return {
    family,
    diagnosticCodes: classified.filter((item) => item.family === family).map((item) => item.code)
  };
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
  classification: FailureClassification,
  progress: SemanticProgressWatermark,
  revision: number
): SemanticFailureCluster {
  if (!current || current.family !== classification.family || !progressMatches(current.progress, progress)) {
    return {
      family: classification.family,
      attempts: 1,
      firstRevision: revision,
      lastRevision: revision,
      diagnosticCodes: classification.diagnosticCodes,
      progress: { ...progress }
    };
  }
  return {
    ...current,
    attempts: current.attempts + 1,
    lastRevision: revision,
    diagnosticCodes: [...new Set([...current.diagnosticCodes, ...classification.diagnosticCodes])]
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
