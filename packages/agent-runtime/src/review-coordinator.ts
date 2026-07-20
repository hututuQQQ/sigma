import { createHash, randomUUID } from "node:crypto";
import type {
  BudgetReservation,
  InputAccessEvidence,
  RepositoryDeltaEvidence,
  ReviewEvidence,
  UsageRecord,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import { consumedBudget } from "./model-accounting.js";
import {
  currentFrontierReview,
  currentWorkspaceReview,
  reviewBasisDigest
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import {
  isAccountableReviewer,
  isActionableErrorFinding,
  COMPLETION_REVIEW_OUTPUT_TOKENS,
  completionCandidateDigest,
  reviewInputFailure,
  reviewInputFailureEvidence,
  type AccountableReviewerPort,
  type CompletionReviewCandidateV1,
  type PreparedReviewerCall,
  type ReviewerInput,
  type ReviewerPort
} from "./reviewer.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { deadlineForecast } from "./convergence-policy.js";
import { reviewObservationProjection } from "./review-observations.js";
import {
  hasReviewSubject,
  profileReviewMode,
  reviewSubjectReadiness
} from "./review-eligibility.js";

function normalizeReview(input: ReviewerInput, raw: ReviewEvidence): ReviewEvidence {
  const findings = [...raw.data.findings];
  const verdict = findings.some(isActionableErrorFinding) ? "changes_requested" : "approved";
  return {
    evidenceId: randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: raw.data.reviewerId },
    summary: verdict === "approved" ? raw.summary : "Independent reviewer requested changes.",
    data: {
      reviewerId: raw.data.reviewerId,
      verdict,
      findings,
      frontierRevision: input.frontierRevision,
      stateDigest: input.stateDigest,
      reviewBasisDigest: input.reviewBasisDigest,
      reviewBasisVersion: 3,
      ...(input.completionCandidateDigest
        ? { completionCandidateDigest: input.completionCandidateDigest } : {}),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      repositoryDeltaEvidenceIds: input.repositoryDeltas?.map((item) => item.evidenceId) ?? [],
      reviewRelevantEvidenceIds: input.observations?.items.map((item) => item.evidenceId) ?? [],
      ...(raw.data.failureKind ? { failureKind: raw.data.failureKind } : {}),
      ...(raw.data.failureCode ? { failureCode: raw.data.failureCode } : {})
    }
  };
}

function failedReview(input: ReviewerInput, reviewerId: string, message: string,
  failureKind: "infrastructure" | "interrupted"): ReviewEvidence {
  return {
    evidenceId: randomUUID(), sessionId: input.sessionId, runId: input.runId,
    kind: "review", status: "failed", createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: reviewerId }, summary: message,
    data: {
      reviewerId, verdict: "changes_requested", findings: [message],
      frontierRevision: input.frontierRevision, stateDigest: input.stateDigest,
      reviewBasisDigest: input.reviewBasisDigest,
      reviewBasisVersion: 3,
      ...(input.completionCandidateDigest
        ? { completionCandidateDigest: input.completionCandidateDigest } : {}),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      repositoryDeltaEvidenceIds: input.repositoryDeltas?.map((item) => item.evidenceId) ?? [],
      reviewRelevantEvidenceIds: input.observations?.items.map((item) => item.evidenceId) ?? [],
      failureKind
    }
  };
}

export interface ReviewReadiness {
  pending: WorkspaceDeltaEvidence[];
  eligible: WorkspaceDeltaEvidence[];
  validations: ValidationEvidence[];
  repositoryDeltas: RepositoryDeltaEvidence[];
  relevantValidations: ValidationEvidence[];
  validationRequiredPaths: string[];
  blockedReview?: ReviewEvidence;
  retryableReview?: ReviewEvidence;
}

function modeBoundCurrentReview(
  session: RuntimeSession,
  completionCandidateDigest?: string
): ReviewEvidence | undefined {
  return completionCandidateDigest === undefined
    ? currentWorkspaceReview(session)
    : currentFrontierReview(session, completionCandidateDigest);
}

export function reviewReadiness(session: RuntimeSession, completionCandidateDigest?: string): ReviewReadiness {
  const readiness = reviewSubjectReadiness(session);
  const latest = modeBoundCurrentReview(session, completionCandidateDigest);
  return {
    ...readiness,
    ...(latest?.status === "failed" && !latest.data.failureKind ? { blockedReview: latest } : {}),
    ...(latest?.status === "failed" && latest.data.failureKind ? { retryableReview: latest } : {})
  };
}

function requestIdentity(
  session: RuntimeSession,
  reviewerId: string,
  attempt: number,
  basisDigest: string
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

function stableUsage(usage: UsageRecord, requestId: string): UsageRecord {
  return { ...usage, usageId: `${requestId}:usage`, requestId, role: "reviewer" };
}

function activeReservation(session: RuntimeSession, ownerId: string): BudgetReservation | undefined {
  return [...session.durable.state.budget.reservations].reverse().find((item) =>
    item.ownerId === ownerId && item.status !== "released");
}

function reviewAttemptNumber(
  session: RuntimeSession,
  existing: ReviewEvidence | undefined,
  explicitlyRequested: boolean,
  retryableReview: ReviewEvidence | undefined,
  completionCandidateDigest?: string
): number | null {
  if (!existing) return 1;
  const candidateBoundRetry = completionCandidateDigest !== undefined
    && existing.data.completionCandidateDigest === completionCandidateDigest;
  if ((!explicitlyRequested && !candidateBoundRetry) || !retryableReview) return null;
  const attempts = session.durable.state.evidence.filter((item) => item.kind === "review"
    && item.sessionId === session.identity.sessionId
    && item.runId === session.durable.runId
    && item.data.reviewBasisDigest === existing.data.reviewBasisDigest
    && item.data.completionCandidateDigest === completionCandidateDigest).length;
  return attempts >= 3 ? null : attempts + 1;
}

function reviewerInput(
  session: RuntimeSession,
  workspaceDeltas: WorkspaceDeltaEvidence[],
  repositoryDeltas: RepositoryDeltaEvidence[],
  validations: ValidationEvidence[],
  validationRequiredPaths: string[],
  reviewBasisDigestValue: string,
  completionCandidate?: CompletionReviewCandidateV1
): ReviewerInput {
  const frontier = session.durable.state.mutationFrontier;
  const observations = reviewObservationProjection(session, validations);
  const candidateDigest = completionCandidate ? completionCandidateDigest(completionCandidate) : undefined;
  return {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    goal: session.durable.state.plan.goal,
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    reviewBasisDigest: reviewBasisDigestValue,
    workspaceDeltas,
    repositoryDeltas,
    validations,
    validationRequiredPaths,
    reviewMode: completionCandidate ? "completion" : "workspace",
    ...(completionCandidate && candidateDigest ? {
      completionCandidate,
      completionCandidateDigest: candidateDigest
    } : {}),
    observations,
    inputAccesses: session.durable.state.evidence.filter((item): item is InputAccessEvidence =>
      item.kind === "input_access" && item.runId === session.durable.runId)
  };
}

export function completionReviewerInput(
  session: RuntimeSession,
  completionCandidate: CompletionReviewCandidateV1
): ReviewerInput {
  const candidateDigest = completionCandidateDigest(completionCandidate);
  const readiness = reviewReadiness(session, candidateDigest);
  const basisDigest = reviewBasisDigest(session, readiness.relevantValidations, candidateDigest);
  return reviewerInput(
    session,
    readiness.eligible,
    readiness.repositoryDeltas,
    readiness.relevantValidations,
    readiness.validationRequiredPaths,
    basisDigest,
    completionCandidate
  );
}

export class ReviewCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly reviewerForSession: (session: RuntimeSession) => ReviewerPort;

  constructor(
    reviewer: ReviewerPort | ((session: RuntimeSession) => ReviewerPort),
    private readonly emit: RuntimeEventEmitter,
    private readonly budgets?: BudgetController
  ) {
    this.reviewerForSession = typeof reviewer === "function" ? reviewer : () => reviewer;
  }

  async maybeReview(
    session: RuntimeSession,
    signal: AbortSignal,
    explicitlyRequested = false,
    completionCandidate?: CompletionReviewCandidateV1
  ): Promise<void> {
    if (profileReviewMode(session) === "off") return;
    // The solver admission path reserved deadline and request capacity for a
    // candidate-bound finishing review. At stop, consume only that reserve;
    // ordinary workspace reviews must not start new work.
    if (deadlineForecast(session).stage === "stop" && completionCandidate === undefined) return;
    const existing = this.active.get(session.identity.sessionId);
    if (existing) return await existing;
    const task = this.reviewEligibleChange(session, signal, explicitlyRequested, completionCandidate);
    this.active.set(session.identity.sessionId, task);
    try { await task; } finally {
      if (this.active.get(session.identity.sessionId) === task) this.active.delete(session.identity.sessionId);
    }
  }

  private async reviewEligibleChange(
    session: RuntimeSession,
    signal: AbortSignal,
    explicitlyRequested: boolean,
    completionCandidate?: CompletionReviewCandidateV1
  ): Promise<void> {
    const candidateDigest = completionCandidate ? completionCandidateDigest(completionCandidate) : undefined;
    const {
      eligible, repositoryDeltas, relevantValidations, validationRequiredPaths, retryableReview
    } = reviewReadiness(
      session,
      candidateDigest
    );
    if (!hasReviewSubject(eligible, repositoryDeltas)) return;
    const existing = modeBoundCurrentReview(session, candidateDigest);
    const attempt = reviewAttemptNumber(
      session, existing, explicitlyRequested, retryableReview, candidateDigest
    );
    if (attempt === null) return;
    const reviewer = this.reviewerForSession(session);
    const reviewerId = reviewer.reviewerId ?? "builtin-reviewer";
    const basisDigest = reviewBasisDigest(session, relevantValidations, candidateDigest);
    const input = reviewerInput(
      session, eligible, repositoryDeltas, relevantValidations,
      validationRequiredPaths, basisDigest, completionCandidate
    );
    const requestId = requestIdentity(session, reviewerId, attempt, basisDigest);
    if (this.budgets && isAccountableReviewer(reviewer)) {
      const prior = activeReservation(session, `reviewer:${requestId}`);
      if (prior) {
        await this.recoverInterruptedReview(session, reviewer, reviewerId, input, requestId, prior);
        return;
      }
    }
    const inputProblem = reviewInputFailure(input);
    if (inputProblem) {
      await this.emit(session, "review.completed", "runtime", normalizeReview(
        input, reviewInputFailureEvidence(input, reviewerId, inputProblem)
      ));
      return;
    }
    if (this.budgets && isAccountableReviewer(reviewer)) {
      await this.reviewAccounted(session, reviewer, reviewerId, input, requestId, signal);
      return;
    }
    await this.emit(session, "review.started", "runtime", {
      reviewerId, requestId,
      workspaceDeltaEvidenceIds: eligible.map((item) => item.evidenceId),
      repositoryDeltaEvidenceIds: repositoryDeltas.map((item) => item.evidenceId),
      validationEvidenceIds: relevantValidations.map((item) => item.evidenceId),
      reviewRelevantEvidenceIds: input.observations?.items.map((item) => item.evidenceId) ?? []
    });
    let raw: ReviewEvidence;
    try { raw = await reviewer.review(input, signal); } catch (error) {
      raw = failedReview(input, reviewerId,
        `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure");
    }
    await this.emit(session, "review.completed", "runtime", this.completedReview(session, input, reviewerId, raw));
  }

  private async reviewAccounted(session: RuntimeSession, reviewer: AccountableReviewerPort,
    reviewerId: string, input: ReviewerInput, requestId: string, signal: AbortSignal): Promise<void> {
    const remaining = Math.max(0, session.durable.state.budget.limits.costMicroUsd
      - session.durable.state.budget.consumed.costMicroUsd
      - session.durable.state.budget.reserved.costMicroUsd);
    const outputLimit = input.reviewMode === "completion"
      ? COMPLETION_REVIEW_OUTPUT_TOKENS
      : deadlineForecast(session).stage === "normal" ? undefined : 2_048;
    let prepared: PreparedReviewerCall;
    let reservationId: string;
    try {
      prepared = await reviewer.prepareReview(input, remaining, outputLimit);
      reservationId = await this.budgets!.reserve(session, `reviewer:${requestId}`, prepared.budget.reserved);
    } catch (error) {
      const raw = failedReview(input, reviewerId,
        `Independent reviewer could not reserve its request: ${error instanceof Error ? error.message : String(error)}`,
        "infrastructure");
      await this.emit(session, "review.completed", "runtime", this.completedReview(session, input, reviewerId, raw));
      return;
    }
    await this.emit(session, "review.started", "runtime", {
      reviewerId, requestId,
      workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
      repositoryDeltaEvidenceIds: input.repositoryDeltas?.map((item) => item.evidenceId) ?? [],
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      reviewRelevantEvidenceIds: input.observations?.items.map((item) => item.evidenceId) ?? []
    });
    const startedAt = performance.now();
    let result: Awaited<ReturnType<AccountableReviewerPort["reviewPrepared"]>>;
    try {
      result = await reviewer.reviewPrepared(input, requestId, prepared, signal);
    } catch (error) {
      const usage = stableUsage(reviewer.failedUsage(input, requestId, prepared, performance.now() - startedAt, error), requestId);
      await this.budgets!.commit(session, reservationId, consumedBudget(usage, prepared.budget));
      await this.emit(session, "usage.recorded", "runtime", usage);
      const raw = failedReview(input, reviewerId,
        `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure");
      await this.emit(session, "review.completed", "runtime", this.completedReview(session, input, reviewerId, raw));
      return;
    }
    const usage = stableUsage(result.usage, requestId);
    await this.budgets!.commitMeasured(session, reservationId, consumedBudget(usage, prepared.budget));
    await this.emit(session, "usage.recorded", "runtime", usage);
    await this.emit(session, "review.completed", "runtime", this.completedReview(
      session, input, reviewerId, result.evidence
    ));
  }

  private async recoverInterruptedReview(session: RuntimeSession, reviewer: AccountableReviewerPort,
    reviewerId: string, input: ReviewerInput, requestId: string, reservation: BudgetReservation): Promise<void> {
    const amounts = reservation.status === "reserved" ? reservation.requested : reservation.consumed;
    if (reservation.status === "reserved") await this.budgets!.commit(session, reservation.reservationId, amounts);
    if (!session.durable.state.usage.some((item) => item.requestId === requestId && item.role === "reviewer")) {
      await this.emit(session, "usage.recorded", "runtime", stableUsage(reviewer.recoveredUsage(input, requestId, amounts), requestId));
    }
    await this.emit(session, "review.completed", "runtime", normalizeReview(input, failedReview(
      input, reviewerId, "Independent review was interrupted; the model call was not replayed.", "interrupted"
    )));
  }

  private completedReview(
    session: RuntimeSession,
    input: ReviewerInput,
    reviewerId: string,
    raw: ReviewEvidence
  ): ReviewEvidence {
    const frontier = session.durable.state.mutationFrontier;
    if (frontier.revision !== input.frontierRevision
      || frontier.currentStateDigest !== input.stateDigest
      || reviewBasisDigest(session, undefined, input.completionCandidateDigest) !== input.reviewBasisDigest) {
      return failedReview(
        input,
        reviewerId,
        "Independent review became stale because its evidence basis changed while the review was running.",
        "interrupted"
      );
    }
    return normalizeReview(input, raw);
  }
}
