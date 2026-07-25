import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BudgetReservation,
  InputAccessEvidence,
  ReviewEvidence,
  UsageRecord,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import { completionCandidate } from "./completion-gate-common.js";
import {
  currentFrontierReview,
  currentFrontierValidationStatus,
  frontierValidationReadiness,
  reviewBasisDigest,
  sessionEnvironmentMutationEvidence,
  sessionMutationEvidence,
  sessionProcessSettlementEvidence,
  unresolvedWorkspaceDeltas
} from "./mutation-evidence.js";
import type { ReviewerInput } from "./reviewer.js";
import {
  postReviewReceiptSummaries,
  sessionReceiptSummaries
} from "./reviewer-post-repair-receipts.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import { goalReferencedWorkspaceReads } from "./reviewer-workspace-reads.js";
import type { RuntimeSession } from "./types.js";

export function profileReviewMode(
  session: RuntimeSession
): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

export function failedReview(
  input: ReviewerInput,
  reviewerId: string,
  message: string,
  failureKind: "infrastructure" | "interrupted",
  failureCode?: "review_unavailable"
): ReviewEvidence {
  return {
    evidenceId: randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId,
    kind: "review",
    status: "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: reviewerId },
    summary: message,
    data: {
      schemaVersion: 3,
      reviewerId,
      verdict: "blocked",
      findings: [message],
      criteria: (input.acceptanceCriteria ?? []).map((criterion) => ({
        criterion,
        status: "unverified" as const,
        evidence: [],
        summary: message
      })),
      requiredValidations: [{
        purpose: "Make the current frontier independently reviewable."
      }],
      frontierRevision: input.frontierRevision,
      stateDigest: input.stateDigest,
      reviewBasisDigest: input.reviewBasisDigest,
      ...(input.completionCandidateDigest
        ? { completionCandidateDigest: input.completionCandidateDigest }
        : {}),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      durableEvidenceIds: input.validations.map((item) => item.evidenceId),
      actualChecks: [],
      failureKind,
      ...(failureCode ? { failureCode } : {})
    }
  };
}

export interface ReviewReadiness {
  pending: WorkspaceDeltaEvidence[];
  eligible: WorkspaceDeltaEvidence[];
  validations: ValidationEvidence[];
  relevantValidations: ValidationEvidence[];
  environmentMutations: ReturnType<typeof sessionEnvironmentMutationEvidence>;
  blockedReview?: ReviewEvidence;
  retryableReview?: ReviewEvidence;
}

export function reviewReadiness(
  session: RuntimeSession,
  reviewMode: ReviewerInput["reviewMode"] = "workspace"
): ReviewReadiness {
  const validation = currentFrontierValidationStatus(session);
  const unresolved = unresolvedWorkspaceDeltas(session);
  const mutationEvidence = sessionMutationEvidence(session);
  const broadWaiver = profileReviewMode(session) !== "required"
    && mutationEvidence.some((item) =>
      item.kind === "user_waiver"
      && item.data.scope === "review"
      && !item.data.checkpointId);
  const environmentMutations = broadWaiver
    ? []
    : sessionEnvironmentMutationEvidence(session);
  const waived = reviewerWaivedDeltaIds(mutationEvidence);
  const pending = profileReviewMode(session) === "required"
    ? unresolved
    : unresolved.filter((item) => !waived.has(item.evidenceId));
  const latest = currentFrontierReview(session);
  const executedFailureReviewable = reviewMode === "completion"
    && validation.validations.some((item) => item.status === "failed"
      && item.data.termination?.processStarted === true
      && item.data.termination.state === "exited");
  return {
    pending,
    eligible: reviewMode === "completion" || validation.passed || executedFailureReviewable
      ? pending : [],
    environmentMutations,
    validations: validation.validations,
    relevantValidations: validation.validations,
    ...(latest?.status === "failed" && !latest.data.failureKind
      ? { blockedReview: latest }
      : {}),
    ...(latest?.status === "failed" && latest.data.failureKind
      ? { retryableReview: latest }
      : {})
  };
}

export function requestIdentity(
  session: RuntimeSession,
  reviewerId: string,
  basisDigest: string,
  attempt: number
): string {
  const frontier = session.durable.state.mutationFrontier;
  return `review:${createHash("sha256").update(JSON.stringify({
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    reviewerId,
    revision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    reviewBasisDigest: basisDigest,
    attempt
  })).digest("hex")}`;
}

export function stableUsage(usage: UsageRecord, requestId: string): UsageRecord {
  return { ...usage, usageId: `${requestId}:usage`, requestId, role: "reviewer" };
}

export function activeReservation(
  session: RuntimeSession,
  ownerId: string
): BudgetReservation | undefined {
  return [...session.durable.state.budget.reservations].reverse().find((item) =>
    item.ownerId === ownerId && item.status !== "released");
}

interface ReviewAttempt {
  eligible: WorkspaceDeltaEvidence[];
  relevantValidations: ValidationEvidence[];
  environmentMutations: ReturnType<typeof sessionEnvironmentMutationEvidence>;
  basisDigest: string;
  basisAttempts: number;
  candidate?: { answer: string; digest: string };
}

function reviewAttemptAllowed(
  existing: ReviewEvidence | undefined,
  explicitlyRequested: boolean
): boolean {
  if (existing?.status === "passed") return false;
  if (existing?.status === "failed" && substantiveReview(existing)) return false;
  return !existing || explicitlyRequested;
}

export function substantiveReview(review: ReviewEvidence): boolean {
  return review.data.schemaVersion === 3
    && review.data.failureKind === undefined
    && review.data.failureCode !== "review_scope_too_large"
    && review.data.failureCode !== "review_protocol_invalid"
    && review.data.failureCode !== "review_unavailable";
}

export function eligibleReviewAttempt(
  session: RuntimeSession,
  explicitlyRequested: boolean,
  reviewMode: ReviewerInput["reviewMode"]
): ReviewAttempt | null {
  const totalReviewAttempts = session.durable.state.evidence.filter((item) =>
    item.kind === "review" && item.runId === session.durable.runId
      && substantiveReview(item)).length;
  const reviewRounds =
    session.services.profile?.profile.assurancePolicy?.reviewRounds ?? 2;
  if (totalReviewAttempts >= reviewRounds) return null;
  const {
    eligible,
    relevantValidations,
    environmentMutations
  } = reviewReadiness(session, reviewMode);
  if (eligible.length === 0 && environmentMutations.length === 0) return null;
  const candidate = reviewMode === "completion" ? completionCandidate(session) : undefined;
  const basisDigest = reviewBasisDigest(session, relevantValidations, candidate?.digest);
  const reviews = session.durable.state.evidence.filter(
    (item): item is ReviewEvidence => item.kind === "review"
      && item.sessionId === session.identity.sessionId
      && item.runId === session.durable.runId
      && item.data.reviewBasisDigest === basisDigest
  );
  const existing = reviews.at(-1);
  const retryableAttempts = reviews.filter((item) => !substantiveReview(item)).length;
  if (existing && !substantiveReview(existing) && retryableAttempts >= 2) return null;
  if (!reviewAttemptAllowed(existing, explicitlyRequested)) return null;
  return {
    eligible,
    relevantValidations,
    environmentMutations,
    basisDigest,
    basisAttempts: reviews.length,
    ...(candidate ? { candidate } : {})
  };
}

export function reviewerInput(
  session: RuntimeSession,
  reviewMode: ReviewerInput["reviewMode"],
  attempt: ReviewAttempt
): ReviewerInput {
  const frontier = session.durable.state.mutationFrontier;
  const durableUserInstructions = session.durable.state.messages
    .filter((message) => message.role === "user")
    .map((message, index) => `User instruction ${index + 1}:\n${message.content}`)
    .join("\n\n");
  const acceptanceCriteria = [...new Set(session.durable.state.plan.nodes
    .flatMap((node) => node.acceptanceCriteria)
    .map((criterion) => criterion.trim())
    .filter(Boolean))];
  const readiness = frontierValidationReadiness(session);
  return {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    goal: durableUserInstructions || session.durable.state.plan.goal,
    acceptanceCriteria,
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    reviewBasisDigest: attempt.basisDigest,
    reviewMode,
    verificationPolicy: profileReviewMode(session) === "required"
      ? "strict"
      : "standard",
    logicalWorkspacePath: session.identity.workspacePath,
    verificationScratchPath: path.join(
      session.identity.workspacePath,
      ".sigma-review-scratch"
    ),
    ...(attempt.candidate ? {
      completionCandidate: attempt.candidate.answer,
      completionCandidateDigest: attempt.candidate.digest
    } : {}),
    workspaceDeltas: attempt.eligible,
    environmentMutations: attempt.environmentMutations,
    processSettlements: sessionProcessSettlementEvidence(session),
    validations: attempt.relevantValidations,
    validationReadiness: {
      ready: readiness.ready,
      missingPaths: readiness.missingPaths,
      missingClaims: readiness.missingClaims,
      ...(readiness.latestFailed
        ? { latestFailureSummary: readiness.latestFailed.summary }
        : {})
    },
    goalReferencedWorkspaceReads: goalReferencedWorkspaceReads(session),
    inputAccesses: session.durable.state.evidence.filter(
      (item): item is InputAccessEvidence =>
        item.kind === "input_access" && item.runId === session.durable.runId
    ),
    sessionReceipts: sessionReceiptSummaries(session),
    postReviewReceipts: postReviewReceiptSummaries(session)
  };
}
