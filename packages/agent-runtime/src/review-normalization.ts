import { randomUUID } from "node:crypto";
import type { ReviewEvidence } from "agent-protocol";
import { isActionableErrorFinding } from "./reviewer-result.js";
import type { RuntimeSession } from "./types.js";

function normalizedReviewVerdict(
  raw: ReviewEvidence
): ReviewEvidence["data"]["verdict"] {
  if (raw.data.failureKind !== undefined || raw.data.verdict === "blocked") {
    return "blocked";
  }
  if (raw.data.findings.some(isActionableErrorFinding)
    || (raw.data.criteria ?? []).some((item) => item.status === "failed")) {
    return "changes_requested";
  }
  if (raw.data.verdict === "validation_required"
    || (raw.data.criteria ?? []).some((item) => item.status === "unverified")
    || (raw.data.requiredValidations?.length ?? 0) > 0) {
    return "changes_requested";
  }
  return "approved";
}

function normalizedReviewSummary(
  raw: ReviewEvidence,
  verdict: ReviewEvidence["data"]["verdict"]
): string {
  if (raw.data.failureKind !== undefined || verdict === "approved") return raw.summary;
  return verdict === "blocked"
    ? "Independent verification was blocked."
    : "Independent reviewer requested changes.";
}

interface ReviewProvenance {
  criteria: NonNullable<ReviewEvidence["data"]["criteria"]>;
  durableEvidenceIds: string[];
  acceptedEvidenceReferences: number;
  droppedEvidenceReferences: number;
  approvedEvidenceAuthentic: boolean;
}

function reviewEvidenceKnownToSession(session: RuntimeSession): Set<string> {
  return new Set([
    ...session.durable.state.evidence.map((item) => item.evidenceId),
    ...session.durable.state.mutationEvidence.map((item) => item.evidenceId),
    ...session.durable.state.reviewReceipts.flatMap((item) =>
      (item.receipt.evidence ?? []).map((evidence) => evidence.evidenceId))
  ]);
}

function reviewChecksAuthentic(
  session: RuntimeSession,
  raw: ReviewEvidence,
  reviewRequestId?: string
): boolean {
  return (raw.data.actualChecks ?? []).every((check) =>
    Boolean(reviewRequestId)
    && check.evidenceIds.length > 0
    && session.durable.state.reviewReceipts.some((receipt) =>
      receipt.reviewRequestId === reviewRequestId
      && receipt.call.name === check.toolName
      && check.evidenceIds.every((evidenceId) =>
        (receipt.receipt.evidence ?? []).some((evidence) =>
          evidence.evidenceId === evidenceId))));
}

function reviewProvenance(
  session: RuntimeSession,
  raw: ReviewEvidence,
  rawVerdict: ReviewEvidence["data"]["verdict"],
  reviewRequestId?: string
): ReviewProvenance {
  const known = reviewEvidenceKnownToSession(session);
  const rawCriteria = raw.data.criteria ?? [];
  const rawEvidenceIds = [...new Set([
    ...(raw.data.durableEvidenceIds ?? []),
    ...rawCriteria.flatMap((criterion) => criterion.evidence)
  ])];
  const criteria = rawCriteria.map((criterion) => ({
    ...criterion,
    evidence: [...new Set(criterion.evidence.filter((id) => known.has(id)))]
  }));
  const durableEvidenceIds = rawEvidenceIds.filter((id) => known.has(id));
  const criteriaAuthentic = criteria.length > 0 && criteria.every((criterion) =>
    criterion.status === "satisfied"
    && criterion.evidence.length > 0);
  return {
    criteria,
    durableEvidenceIds,
    acceptedEvidenceReferences: durableEvidenceIds.length,
    droppedEvidenceReferences: rawEvidenceIds.length - durableEvidenceIds.length,
    approvedEvidenceAuthentic: rawVerdict !== "approved"
      || criteriaAuthentic
        && reviewChecksAuthentic(session, raw, reviewRequestId)
  };
}

function normalizedReviewData(input: {
  raw: ReviewEvidence;
  verdict: ReviewEvidence["data"]["verdict"];
  findings: ReviewEvidence["data"]["findings"];
  frontierRevision: number;
  stateDigest: string;
  basisDigest: string;
  criteria: NonNullable<ReviewEvidence["data"]["criteria"]>;
  durableEvidenceIds: string[];
  acceptedEvidenceReferences: number;
  droppedEvidenceReferences: number;
  protocolEvidenceFailure: boolean;
  completionCandidateDigest?: string;
  reviewRequestId?: string;
}): ReviewEvidence["data"] {
  const completionDigest = input.raw.data.completionCandidateDigest
    ?? input.completionCandidateDigest;
  return {
    schemaVersion: 1,
    reviewerId: input.raw.data.reviewerId,
    ...(input.reviewRequestId ? { reviewRequestId: input.reviewRequestId } : {}),
    verdict: input.verdict,
    findings: input.findings,
    criteria: input.criteria,
    requiredValidations: input.raw.data.requiredValidations ?? [],
    frontierRevision: input.frontierRevision,
    stateDigest: input.stateDigest,
    reviewBasisDigest: input.basisDigest,
    ...(completionDigest ? { completionCandidateDigest: completionDigest } : {}),
    validationEvidenceIds: input.raw.data.validationEvidenceIds,
    ...(input.durableEvidenceIds.length > 0
      ? { durableEvidenceIds: input.durableEvidenceIds }
      : {}),
    ...(input.raw.data.actualChecks
      ? { actualChecks: input.raw.data.actualChecks.map((item) => ({
          ...item,
          evidenceIds: [...item.evidenceIds]
        })) }
      : {}),
    ...(input.droppedEvidenceReferences > 0
      ? {
          evidenceReferenceResolution: {
            accepted: input.acceptedEvidenceReferences,
            dropped: input.droppedEvidenceReferences
          }
        }
      : {}),
    ...(input.protocolEvidenceFailure
      ? {
          failureKind: "protocol" as const,
          failureCode: "review_protocol_invalid" as const
        }
      : {
          ...(input.raw.data.failureKind
            ? { failureKind: input.raw.data.failureKind }
            : {}),
          ...(input.raw.data.failureCode
            ? { failureCode: input.raw.data.failureCode }
            : {})
        })
  };
}

export function normalizeReview(
  session: RuntimeSession,
  raw: ReviewEvidence,
  basisDigest: string,
  completionCandidateDigest?: string,
  reviewRequestId?: string
): ReviewEvidence {
  const frontier = session.durable.state.mutationFrontier;
  const rawVerdict = normalizedReviewVerdict(raw);
  const provenance = reviewProvenance(
    session,
    raw,
    rawVerdict,
    reviewRequestId
  );
  const verdict = provenance.approvedEvidenceAuthentic ? rawVerdict : "blocked";
  const protocolEvidenceFailure = rawVerdict === "approved"
    && !provenance.approvedEvidenceAuthentic;
  const findings = protocolEvidenceFailure
    ? [...raw.data.findings, "Reviewer approval cited missing or non-durable evidence."]
    : [...raw.data.findings];
  return {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: raw.data.reviewerId },
    summary: protocolEvidenceFailure
      ? "Independent reviewer approval failed durable evidence verification."
      : normalizedReviewSummary(raw, verdict),
    data: normalizedReviewData({
      raw,
      verdict,
      findings,
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      basisDigest,
      criteria: provenance.criteria,
      durableEvidenceIds: provenance.durableEvidenceIds,
      acceptedEvidenceReferences: provenance.acceptedEvidenceReferences,
      droppedEvidenceReferences: provenance.droppedEvidenceReferences,
      protocolEvidenceFailure,
      completionCandidateDigest,
      reviewRequestId
    })
  };
}
