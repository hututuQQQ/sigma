import { createHash, randomUUID } from "node:crypto";
import type {
  BudgetReservation,
  InputAccessEvidence,
  ReviewEvidence,
  UsageRecord,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import { consumedBudget } from "./model-accounting.js";
import {
  currentFrontierReview,
  frontierValidationReadiness,
  reviewBasisDigest,
  sessionMutationEvidence,
  unresolvedWorkspaceDeltas
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import {
  isAccountableReviewer,
  isActionableErrorFinding,
  reviewInputFailure,
  reviewInputFailureEvidence,
  type AccountableReviewerPort,
  type ReviewerInput,
  type ReviewerPort
} from "./reviewer.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import { deadlineForecast } from "./convergence-policy.js";
import { assuranceRequirement } from "./assurance-engine.js";
import { goalReferencedWorkspaceReads } from "./reviewer-workspace-reads.js";
export { goalReferencedWorkspaceReads } from "./reviewer-workspace-reads.js";

function profileReviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

function normalizeReview(session: RuntimeSession, raw: ReviewEvidence, basisDigest: string): ReviewEvidence {
  const frontier = session.durable.state.mutationFrontier;
  const findings = [...raw.data.findings];
  const protocolOrInfrastructureFailure = raw.data.failureKind !== undefined;
  const verdict = protocolOrInfrastructureFailure || findings.some(isActionableErrorFinding)
    ? "changes_requested" : "approved";
  return {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: raw.data.reviewerId },
    summary: protocolOrInfrastructureFailure ? raw.summary
      : verdict === "approved" ? raw.summary : "Independent reviewer requested changes.",
    data: {
      reviewerId: raw.data.reviewerId,
      verdict,
      findings,
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      reviewBasisDigest: basisDigest,
      validationEvidenceIds: raw.data.validationEvidenceIds,
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
      validationEvidenceIds: input.validations.map((item) => item.evidenceId), failureKind
    }
  };
}

export interface ReviewReadiness {
  pending: WorkspaceDeltaEvidence[];
  eligible: WorkspaceDeltaEvidence[];
  validations: ValidationEvidence[];
  relevantValidations: ValidationEvidence[];
  blockedReview?: ReviewEvidence;
  retryableReview?: ReviewEvidence;
}

export function reviewReadiness(
  session: RuntimeSession,
  reviewMode: ReviewerInput["reviewMode"] = "workspace"
): ReviewReadiness {
  const validation = frontierValidationReadiness(session);
  const unresolved = unresolvedWorkspaceDeltas(session);
  const waived = reviewerWaivedDeltaIds(sessionMutationEvidence(session));
  // A user waiver suppresses optional reviewer work (and its cost), while the
  // required profile deliberately continues to demand an actual review.
  const pending = profileReviewMode(session) === "required"
    ? unresolved
    : unresolved.filter((item) => !waived.has(item.evidenceId));
  const latest = currentFrontierReview(session);
  const executedFailureReviewable = reviewMode === "completion"
    && validation.executionReady
    && assuranceRequirement(session).risk !== "high";
  return {
    pending,
    eligible: validation.ready || executedFailureReviewable
      ? pending : [],
    validations: validation.validations,
    relevantValidations: validation.validations,
    ...(latest?.status === "failed" && !latest.data.failureKind ? { blockedReview: latest } : {}),
    ...(latest?.status === "failed" && latest.data.failureKind ? { retryableReview: latest } : {})
  };
}

function requestIdentity(
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

function stableUsage(usage: UsageRecord, requestId: string): UsageRecord {
  return { ...usage, usageId: `${requestId}:usage`, requestId, role: "reviewer" };
}

function activeReservation(session: RuntimeSession, ownerId: string): BudgetReservation | undefined {
  return [...session.durable.state.budget.reservations].reverse().find((item) =>
    item.ownerId === ownerId && item.status !== "released");
}

interface ReviewAttempt {
  eligible: WorkspaceDeltaEvidence[];
  relevantValidations: ValidationEvidence[];
  basisDigest: string;
  basisAttempts: number;
  candidate?: { answer: string; digest: string };
}

function reviewAttemptAllowed(
  existing: ReviewEvidence | undefined,
  explicitlyRequested: boolean,
  attemptCount: number
): boolean {
  if (existing?.status === "passed") return false;
  if (existing?.status === "failed" && !existing.data.failureKind) return false;
  if (existing?.data.failureKind !== "protocol" && existing && !explicitlyRequested) return false;
  const attemptLimit = existing?.data.failureKind === "protocol" ? 2 : 3;
  return attemptCount < attemptLimit;
}

function eligibleReviewAttempt(
  session: RuntimeSession,
  explicitlyRequested: boolean,
  reviewMode: ReviewerInput["reviewMode"]
): ReviewAttempt | null {
  const { eligible, relevantValidations } = reviewReadiness(session, reviewMode);
  if (eligible.length === 0) return null;
  const candidate = reviewMode === "completion" ? session.durable.state.taskControl.completionCandidate : undefined;
  const basisDigest = reviewBasisDigest(session, relevantValidations, candidate?.digest);
  const reviews = session.durable.state.evidence.filter((item): item is ReviewEvidence => item.kind === "review"
    && item.sessionId === session.identity.sessionId && item.runId === session.durable.runId
    && item.data.reviewBasisDigest === basisDigest);
  const existing = reviews.at(-1);
  if (!reviewAttemptAllowed(existing, explicitlyRequested, reviews.length)) return null;
  return { eligible, relevantValidations, basisDigest, basisAttempts: reviews.length, ...(candidate ? { candidate } : {}) };
}

function reviewerInput(
  session: RuntimeSession,
  reviewMode: ReviewerInput["reviewMode"],
  attempt: ReviewAttempt
): ReviewerInput {
  const frontier = session.durable.state.mutationFrontier;
  return {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    goal: session.durable.state.plan.goal,
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    reviewBasisDigest: attempt.basisDigest,
    reviewMode,
    ...(attempt.candidate ? {
      completionCandidate: attempt.candidate.answer,
      completionCandidateDigest: attempt.candidate.digest
    } : {}),
    workspaceDeltas: attempt.eligible,
    validations: attempt.relevantValidations,
    goalReferencedWorkspaceReads: goalReferencedWorkspaceReads(session),
    inputAccesses: session.durable.state.evidence.filter((item): item is InputAccessEvidence =>
      item.kind === "input_access" && item.runId === session.durable.runId)
  };
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
    reviewMode: ReviewerInput["reviewMode"] = "workspace"
  ): Promise<void> {
    if (profileReviewMode(session) === "off") return;
    if (deadlineForecast(session).stage === "stop") return;
    const existing = this.active.get(session.identity.sessionId);
    if (existing) return await existing;
    const task = this.reviewEligibleChange(session, signal, explicitlyRequested, reviewMode);
    this.active.set(session.identity.sessionId, task);
    try { await task; } finally {
      if (this.active.get(session.identity.sessionId) === task) this.active.delete(session.identity.sessionId);
    }
  }

  private async reviewEligibleChange(
    session: RuntimeSession,
    signal: AbortSignal,
    explicitlyRequested: boolean,
    reviewMode: ReviewerInput["reviewMode"]
  ): Promise<void> {
    const attempt = eligibleReviewAttempt(session, explicitlyRequested, reviewMode);
    if (!attempt) return;
    const reviewer = this.reviewerForSession(session);
    const reviewerId = reviewer.reviewerId ?? "builtin-reviewer";
    const input = reviewerInput(session, reviewMode, attempt);
    const requestId = requestIdentity(session, reviewerId, attempt.basisDigest, attempt.basisAttempts + 1);
    if (await this.recoverActiveReview(session, reviewer, reviewerId, input, requestId)) return;
    const inputProblem = reviewInputFailure(input);
    if (inputProblem) {
      await this.emit(session, "review.completed", "runtime", normalizeReview(
        session, reviewInputFailureEvidence(input, reviewerId, inputProblem), attempt.basisDigest
      ));
      return;
    }
    const normalized = this.budgets && isAccountableReviewer(reviewer)
      ? await this.reviewAccounted(session, reviewer, reviewerId, input, requestId, signal)
      : await this.reviewUnaccounted(session, reviewer, reviewerId, input, requestId, signal);
    if (normalized.data.failureKind === "protocol" && attempt.basisAttempts + 1 < 2) {
      await this.reviewEligibleChange(session, signal, true, reviewMode);
    }
  }

  private async recoverActiveReview(
    session: RuntimeSession,
    reviewer: ReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    requestId: string
  ): Promise<boolean> {
    if (!this.budgets || !isAccountableReviewer(reviewer)) return false;
    const prior = activeReservation(session, `reviewer:${requestId}`);
    if (!prior) return false;
    await this.recoverInterruptedReview(session, reviewer, reviewerId, input, requestId, prior);
    return true;
  }

  private async reviewUnaccounted(
    session: RuntimeSession,
    reviewer: ReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    requestId: string,
    signal: AbortSignal
  ): Promise<ReviewEvidence> {
    await this.emit(session, "review.started", "runtime", {
      reviewerId, requestId,
      workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId)
    });
    let raw: ReviewEvidence;
    try { raw = await reviewer.review(input, signal); } catch (error) {
      raw = failedReview(input, reviewerId,
        `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure");
    }
    const normalized = normalizeReview(session, raw, input.reviewBasisDigest);
    await this.emit(session, "review.completed", "runtime", normalized);
    return normalized;
  }

  private async reviewAccounted(session: RuntimeSession, reviewer: AccountableReviewerPort,
    reviewerId: string, input: ReviewerInput, requestId: string, signal: AbortSignal): Promise<ReviewEvidence> {
    const remaining = Math.max(0, session.durable.state.budget.limits.costMicroUsd
      - session.durable.state.budget.consumed.costMicroUsd
      - session.durable.state.budget.reserved.costMicroUsd);
    const outputLimit = deadlineForecast(session).stage === "converge" ? 2_048 : undefined;
    const prepared = await reviewer.prepareReview(input, remaining, outputLimit);
    const reservationId = await this.budgets!.reserve(session, `reviewer:${requestId}`, prepared.budget.reserved);
    await this.emit(session, "review.started", "runtime", {
      reviewerId, requestId,
      workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId)
    });
    const startedAt = performance.now();
    let result: Awaited<ReturnType<AccountableReviewerPort["reviewPrepared"]>>;
    try {
      result = await reviewer.reviewPrepared(input, requestId, prepared, signal);
    } catch (error) {
      const usage = stableUsage(reviewer.failedUsage(input, requestId, prepared, performance.now() - startedAt, error), requestId);
      await this.budgets!.commit(session, reservationId, consumedBudget(usage, prepared.budget));
      await this.emit(session, "usage.recorded", "runtime", usage);
      const normalized = normalizeReview(session, failedReview(
        input, reviewerId, `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure"
      ), input.reviewBasisDigest);
      await this.emit(session, "review.completed", "runtime", normalized);
      return normalized;
    }
    const usage = stableUsage(result.usage, requestId);
    await this.budgets!.commitMeasured(session, reservationId, consumedBudget(usage, prepared.budget));
    await this.emit(session, "usage.recorded", "runtime", usage);
    const normalized = normalizeReview(
      session, result.evidence, input.reviewBasisDigest
    );
    await this.emit(session, "review.completed", "runtime", normalized);
    return normalized;
  }

  private async recoverInterruptedReview(session: RuntimeSession, reviewer: AccountableReviewerPort,
    reviewerId: string, input: ReviewerInput, requestId: string, reservation: BudgetReservation): Promise<void> {
    const amounts = reservation.status === "reserved" ? reservation.requested : reservation.consumed;
    if (reservation.status === "reserved") await this.budgets!.commit(session, reservation.reservationId, amounts);
    if (!session.durable.state.usage.some((item) => item.requestId === requestId && item.role === "reviewer")) {
      await this.emit(session, "usage.recorded", "runtime", stableUsage(reviewer.recoveredUsage(input, requestId, amounts), requestId));
    }
    await this.emit(session, "review.completed", "runtime", normalizeReview(session, failedReview(
      input, reviewerId, "Independent review was interrupted; the model call was not replayed.", "interrupted"
    ), input.reviewBasisDigest));
  }
}
