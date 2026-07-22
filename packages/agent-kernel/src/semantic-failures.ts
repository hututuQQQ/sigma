import {
  INFRASTRUCTURE_FAILURE_LIMIT,
  isCompletionEligibleEvidence,
  type EvidenceRecord,
  type ToolReceipt,
  type WorkspaceDelta
} from "agent-protocol";
import { createHash } from "node:crypto";
import type { KernelState } from "./state.js";
import {
  recordSemanticFact,
  taskControlFailureMessage
} from "./task-control.js";

export const SEMANTIC_INFRASTRUCTURE_FAILURE_LIMIT = INFRASTRUCTURE_FAILURE_LIMIT;
export const SEMANTIC_INFRASTRUCTURE_FAILURE_CODE = "tool_infrastructure_failure_loop";

export interface SemanticFailureUpdate {
  state: KernelState;
  limitReached: boolean;
}

function sortedDelta(delta: WorkspaceDelta): WorkspaceDelta {
  return {
    added: [...new Set(delta.added)].sort(),
    modified: [...new Set(delta.modified)].sort(),
    deleted: [...new Set(delta.deleted)].sort()
  };
}

function hasDelta(delta: WorkspaceDelta | undefined): delta is WorkspaceDelta {
  return Boolean(delta && delta.added.length + delta.modified.length + delta.deleted.length > 0);
}

export function semanticInfrastructureFailureMessage(state: KernelState): string {
  const episode = state.taskControl.episode;
  return taskControlFailureMessage(
    state.taskControl,
    `Actions made no trusted progress for ${episode.noProgressBatches} completed batches in the current episode.`
  );
}

export function recordSemanticToolResult(
  state: KernelState,
  receipt: ToolReceipt,
  toolName: string
): SemanticFailureUpdate {
  let taskControl = state.taskControl;
  if (hasDelta(receipt.workspaceDelta)) {
    taskControl = recordSemanticFact(
      taskControl,
      "workspace_frontier",
      { delta: sortedDelta(receipt.workspaceDelta) },
      state.revision
    ).control;
  }
  const readSubject = receipt.ok ? semanticReadSubject(toolName, receipt) : null;
  if (readSubject) {
    taskControl = recordSemanticFact(
      taskControl,
      "content",
      readSubject,
      state.revision
    ).control;
  }
  const progressed = taskControl === state.taskControl ? state : { ...state, taskControl };
  return { state: progressed, limitReached: taskControl.phase === "terminal" };
}

const CONTENT_READ_TOOLS = new Set([
  "read", "list", "grep", "repository_stats", "git_status", "git_diff", "lsp"
]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function semanticReadSubject(toolName: string, receipt: ToolReceipt): unknown | null {
  if (!CONTENT_READ_TOOLS.has(toolName)) return null;
  const result = object(receipt.result);
  if (toolName === "read" && result?.status === "read"
    && typeof result.path === "string" && typeof result.sha256 === "string") {
    return { toolName, path: result.path, contentDigest: result.sha256 };
  }
  return {
    toolName,
    contentDigest: createHash("sha256").update(receipt.output, "utf8").digest("hex")
  };
}

export function recordSemanticEvidenceProgress(state: KernelState, evidence: EvidenceRecord): KernelState {
  if (!isCompletionEligibleEvidence(evidence, state.sessionId, state.runId)) return state;
  const evidenceFromFailedTool = evidence.producer.authority === "tool"
    && state.receipts.some((receipt) => receipt.callId === evidence.producer.id && !receipt.ok);
  if (evidenceFromFailedTool) return state;
  const semantic = semanticEvidence(evidence);
  if (!semantic) return state;
  const fact = recordSemanticFact(state.taskControl, semantic.kind, semantic.subject, state.revision);
  return fact.trustedProgress ? { ...state, taskControl: fact.control } : state;
}

type SemanticEvidence = {
  kind: Parameters<typeof recordSemanticFact>[1]; subject: unknown;
};

function semanticMutationEvidence(evidence: EvidenceRecord): SemanticEvidence | null {
  switch (evidence.kind) {
    case "workspace_delta":
      return { kind: "workspace_frontier", subject: {
        delta: evidence.data.delta,
        reviewContentDigest: evidence.data.reviewDiff
          ? createHash("sha256").update(evidence.data.reviewDiff, "utf8").digest("hex") : null,
        opaqueArtifacts: evidence.data.opaqueArtifacts ?? []
      } };
    case "repository_delta":
      return { kind: "repository", subject: {
        afterStateDigest: evidence.data.afterStateDigest,
        headAfter: evidence.data.headAfter,
        refsAfterDigest: evidence.data.refsAfterDigest,
        indexAfterDigest: evidence.data.indexAfterDigest
      } };
    case "validation":
      return { kind: "validation", subject: {
        status: evidence.status,
        frontierRevision: evidence.data.frontierRevision,
        stateDigest: evidence.data.stateDigest,
        coveredPaths: evidence.data.coveredPaths,
        claim: evidence.data.claim ?? null
      } };
    case "review":
      return { kind: "review", subject: {
        status: evidence.status,
        verdict: evidence.data.verdict,
        reviewBasisDigest: evidence.data.reviewBasisDigest ?? null,
        failureKind: evidence.data.failureKind ?? null,
        findings: evidence.data.findings
      } };
    default:
      return null;
  }
}

function semanticAuxiliaryEvidence(evidence: EvidenceRecord): SemanticEvidence | null {
  switch (evidence.kind) {
    case "input_access":
      return { kind: "content", subject: {
        path: evidence.data.path,
        contentDigest: evidence.data.sha256 ?? null,
        failureCode: evidence.data.failureCode ?? null
      } };
    case "child_outcome":
      return { kind: "plan", subject: {
        childId: evidence.data.childId,
        outcome: evidence.data.outcome,
        planNodeIds: evidence.data.planNodeIds
      } };
    case "user_waiver":
      return { kind: "review", subject: {
        authority: "user", scope: evidence.data.scope, reason: evidence.data.reason
      } };
    case "restoration":
      return { kind: "restoration", subject: evidence.data };
    case "command":
    case "diagnostic":
    case "checkpoint":
      return null;
    default:
      return null;
  }
}

function semanticEvidence(evidence: EvidenceRecord): SemanticEvidence | null {
  return semanticMutationEvidence(evidence) ?? semanticAuxiliaryEvidence(evidence);
}

export function recordSemanticWorkspaceRestore(state: KernelState): KernelState {
  const fact = recordSemanticFact(state.taskControl, "restoration", {
    frontierRevision: state.mutationFrontier.revision,
    stateDigest: state.mutationFrontier.currentStateDigest,
    baselineManifestDigest: state.mutationFrontier.baselineManifestDigest,
    changedPaths: state.mutationFrontier.changedPaths
  }, state.revision);
  return fact.trustedProgress ? { ...state, taskControl: fact.control } : state;
}
