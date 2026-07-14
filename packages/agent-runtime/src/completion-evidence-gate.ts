import {
  evidenceSupportsClaim,
  isCompletionEligibleEvidence,
  isCompletionReferenceableEvidence,
  type EvidenceClaim,
  type EvidenceRecord,
  type JsonValue,
  type ModelToolCall,
  type PlanGraph,
  type ToolDescriptor,
  type ToolReceipt,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "agent-protocol";
import { completionEvidenceError, parseCompletionProposal } from "agent-tools";
import { sessionMutationEvidence } from "./mutation-evidence.js";
import { reviewReadiness } from "./review-coordinator.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import { documentationOnly } from "./reviewer.js";
import { failed } from "./tool-receipt.js";
import type { RuntimeSession } from "./types.js";
import { validationCoversDelta } from "./validation-policy.js";

export function currentRunEvidence(session: RuntimeSession): EvidenceRecord[] {
  return session.durable.state.evidence.filter((item) =>
    isCompletionReferenceableEvidence(item, session.identity.sessionId, session.durable.runId));
}

function evidenceClaims(item: EvidenceRecord): EvidenceClaim[] {
  const claims: EvidenceClaim[] = [];
  if (isCompletionEligibleEvidence(item, item.sessionId, item.runId)) claims.push("acceptance_met");
  if (evidenceSupportsClaim(item, "validation_executed")) claims.push("validation_executed");
  if (evidenceSupportsClaim(item, "validation_passed")) claims.push("validation_passed");
  return claims;
}

function availableEvidenceResult(session: RuntimeSession): JsonValue[] {
  return currentRunEvidence(session)
    .slice(-96)
    .map((item) => ({
      evidenceId: item.evidenceId,
      kind: item.kind,
      status: item.status,
      claims: evidenceClaims(item)
    }));
}

interface CompletionChangeFailure {
  code: "validation_evidence_required" | "review_evidence_required";
  message: string;
  missing: JsonValue[];
  nextActions: JsonValue[];
}

function validationChangeEvidenceFailure(
  evidence: readonly EvidenceRecord[],
  deltas: readonly WorkspaceDeltaEvidence[]
): CompletionChangeFailure | null {
  const validations = evidence.filter((item): item is ValidationEvidence =>
    item.kind === "validation" && item.status === "passed");
  const unvalidated = deltas.filter((delta) => !validations.some((validation) =>
    validationCoversDelta(validation, delta)));
  if (unvalidated.length === 0) return null;
  const ids = unvalidated.map((item) => item.evidenceId);
  return {
    code: "validation_evidence_required",
    message: `Workspace deltas require corresponding passed validation evidence: ${ids.join(", ")}.`,
    missing: unvalidated.map((item) => ({
      requirement: "validation_passed",
      workspaceDeltaEvidenceId: item.evidenceId,
      checkpointId: item.data.checkpointId,
      expectedEvidence: {
        kind: "validation",
        status: "passed",
        claim: "validation_passed",
        workspaceDeltaEvidenceIds: [item.evidenceId]
      }
    })),
    nextActions: [{ tool: "validate", arguments: { workspaceDeltaEvidenceIds: ids } }]
  };
}

function reviewChangeEvidenceFailure(
  session: RuntimeSession,
  evidence: readonly EvidenceRecord[],
  deltas: readonly WorkspaceDeltaEvidence[]
): CompletionChangeFailure | null {
  const waivedIds = reviewerWaivedDeltaIds(evidence);
  const reviewedIds = new Set(evidence.flatMap((item) => item.kind === "review" && item.status === "passed"
    && item.data.verdict === "approved"
    ? item.data.workspaceDeltaEvidenceIds : []));
  const unreviewed = deltas.filter((item) => !documentationOnly(item)
    && !reviewedIds.has(item.evidenceId) && !waivedIds.has(item.evidenceId));
  if (unreviewed.length === 0) return null;
  const ids = unreviewed.map((item) => item.evidenceId);
  const { blockedReview, retryableReview } = reviewReadiness(session);
  return {
    code: "review_evidence_required",
    message: `Non-documentation deltas require corresponding approved review evidence: ${ids.join(", ")}.`,
    missing: unreviewed.map((item) => {
      const latest = evidence.filter((candidate) => candidate.kind === "review"
        && candidate.data.workspaceDeltaEvidenceIds.includes(item.evidenceId)).at(-1);
      return {
        requirement: "review_approved",
        workspaceDeltaEvidenceId: item.evidenceId,
        checkpointId: item.data.checkpointId,
        expectedEvidence: {
          kind: "review",
          status: "passed",
          verdict: "approved",
          claim: "acceptance_met",
          workspaceDeltaEvidenceIds: [item.evidenceId]
        },
        ...(latest?.kind === "review" ? {
          latestReview: {
            evidenceId: latest.evidenceId,
            status: latest.status,
            verdict: latest.data.verdict,
            ...(latest.data.failureKind ? { failureKind: latest.data.failureKind } : {}),
            findings: latest.data.findings.slice(0, 20)
          }
        } : {})
      };
    }),
    nextActions: blockedReview ? [
      {
        action: "address_review_findings",
        reviewEvidenceId: blockedReview.evidenceId,
        findings: blockedReview.data.findings.slice(0, 20)
      },
      {
        tool: "validate",
        arguments: {},
        after: "Create the repair workspace delta; omit evidence IDs to bind all unresolved deltas."
      },
      { tool: "request_review", arguments: {}, after: "Passed validation records the repair scope." }
    ] : [{
      tool: "request_review",
      arguments: {},
      ...(retryableReview ? { retryOfReviewEvidenceId: retryableReview.evidenceId } : {}),
      citeOnSuccess: {
        source: "next_current_run_evidence_ledger",
        kind: "review",
        status: "passed",
        verdict: "approved",
        claim: "acceptance_met",
        workspaceDeltaEvidenceIds: ids
      }
    }]
  };
}

function completionChangeEvidenceFailure(session: RuntimeSession): CompletionChangeFailure | null {
  const evidence = sessionMutationEvidence(session);
  const deltas = evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed");
  if (deltas.length === 0) return null;
  return validationChangeEvidenceFailure(evidence, deltas)
    ?? reviewChangeEvidenceFailure(session, evidence, deltas);
}

export function completionFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string
): ToolReceipt | null {
  if (!descriptor.possibleEffects.includes("outcome.propose")) return null;
  if (session.durable.state.activeProcessIds.length > 0) {
    return failed(
      call,
      startedAt,
      `Completion is blocked while background processes remain active: ${session.durable.state.activeProcessIds.join(", ")}. Poll or terminate them first.`,
      "active_processes"
    );
  }
  if (session.durable.state.checkpointHead?.status === "open" || session.recovery.openCheckpointRecovery) {
    return failed(
      call,
      startedAt,
      "Completion is blocked until the open mutation checkpoint is explicitly restored or kept by the user.",
      "checkpoint_recovery_required"
    );
  }
  const proposal = parseCompletionProposal(call.arguments);
  if (!proposal) return failed(
    call,
    startedAt,
    "Completion proposal does not match the required schema.",
    "invalid_completion_proposal",
    { status: "rejected", code: "invalid_completion_proposal" }
  );
  const availableEvidence = new Map(currentRunEvidence(session)
    .map((item) => [item.evidenceId, item] as const));
  const evidenceError = completionEvidenceError(proposal, availableEvidence);
  if (!evidenceError) {
    const changeFailure = completionChangeEvidenceFailure(session);
    if (!changeFailure) return null;
    return failed(call, startedAt, changeFailure.message, changeFailure.code, {
      status: "rejected",
      code: changeFailure.code,
      missing: changeFailure.missing,
      nextActions: changeFailure.nextActions,
      availableEvidence: availableEvidenceResult(session)
    });
  }
  const available = [...availableEvidence.values()].slice(-20)
    .map((item) => `${item.evidenceId}:${item.kind}:${evidenceClaims(item).join("|")}`);
  const guidance = available.length > 0
    ? `Copy exact evidenceId/kind/claim values from the structured availableEvidence result: ${available.join(", ")}.`
    : "No referenceable durable evidence is available yet; run the required inspection, mutation, or validation tool first.";
  return failed(call, startedAt, `${evidenceError}\n${guidance}`, "invalid_completion_evidence", {
    status: "rejected",
    code: "invalid_completion_evidence",
    availableEvidence: availableEvidenceResult(session)
  });
}

export function completionPlan(session: RuntimeSession): PlanGraph | null {
  const pending = session.durable.state.plan.nodes.filter((node) =>
    node.status !== "completed" && node.status !== "cancelled");
  if (pending.length !== 1 || pending[0]?.id !== "root" || pending[0].status !== "in_progress") return null;
  const evidence = currentRunEvidence(session)
    .map((item) => ({
      evidenceId: item.evidenceId,
      kind: item.kind,
      claim: isCompletionEligibleEvidence(item, session.identity.sessionId, session.durable.runId)
        ? "acceptance_met" as const : "validation_executed" as const
    }));
  if (evidence.length === 0) return null;
  return {
    ...session.durable.state.plan,
    revision: session.durable.state.plan.revision + 1,
    activeNodeId: undefined,
    nodes: session.durable.state.plan.nodes.map((node) => node.id === "root"
      ? { ...node, status: "completed" as const, evidence }
      : node)
  };
}

export function completionPlanError(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  const incomplete = session.durable.state.plan.nodes.filter((node) =>
    node.status !== "completed" && node.status !== "cancelled");
  return incomplete.length === 0 ? null : failed(
    call,
    startedAt,
    `Completion is blocked by unfinished plan nodes: ${incomplete.map((node) => `${node.id}:${node.status}`).join(", ")}.`,
    "plan_incomplete"
  );
}
