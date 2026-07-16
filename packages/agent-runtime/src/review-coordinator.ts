import { createHash, randomUUID } from "node:crypto";
import type {
  BudgetReservation,
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
  sessionMutationEvidence,
  unresolvedWorkspaceDeltas
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import {
  isAccountableReviewer,
  reviewInputFailure,
  reviewInputFailureEvidence,
  type AccountableReviewerPort,
  type ReviewerInput,
  type ReviewerPort
} from "./reviewer.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";

function profileReviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

function normalizeReview(session: RuntimeSession, raw: ReviewEvidence): ReviewEvidence {
  const frontier = session.durable.state.mutationFrontier;
  const findings = [...raw.data.findings];
  const verdict = raw.data.verdict === "approved" && findings.length === 0 ? "approved" : "changes_requested";
  return {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: raw.data.reviewerId },
    summary: verdict === "approved" ? raw.summary : "Independent reviewer requested changes.",
    data: {
      reviewerId: raw.data.reviewerId,
      verdict,
      findings,
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      validationEvidenceIds: raw.data.validationEvidenceIds,
      ...(raw.data.failureKind ? { failureKind: raw.data.failureKind } : {})
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

export function reviewReadiness(session: RuntimeSession): ReviewReadiness {
  const validation = frontierValidationReadiness(session);
  const unresolved = unresolvedWorkspaceDeltas(session);
  const waived = reviewerWaivedDeltaIds(sessionMutationEvidence(session));
  // A user waiver suppresses optional reviewer work (and its cost), while the
  // required profile deliberately continues to demand an actual review.
  const pending = profileReviewMode(session) === "required"
    ? unresolved
    : unresolved.filter((item) => !waived.has(item.evidenceId));
  const latest = currentFrontierReview(session);
  return {
    pending,
    eligible: validation.ready ? pending : [],
    validations: validation.validations,
    relevantValidations: validation.validations.filter((item) => item.status === "passed"),
    ...(latest?.status === "failed" && !latest.data.failureKind ? { blockedReview: latest } : {}),
    ...(latest?.status === "failed" && latest.data.failureKind ? { retryableReview: latest } : {})
  };
}

function requestIdentity(session: RuntimeSession, reviewerId: string): string {
  const frontier = session.durable.state.mutationFrontier;
  return `review:${createHash("sha256").update(JSON.stringify({
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    reviewerId,
    revision: frontier.revision,
    stateDigest: frontier.currentStateDigest
  })).digest("hex")}`;
}

function stableUsage(usage: UsageRecord, requestId: string): UsageRecord {
  return { ...usage, usageId: `${requestId}:usage`, requestId, role: "reviewer" };
}

function activeReservation(session: RuntimeSession, ownerId: string): BudgetReservation | undefined {
  return [...session.durable.state.budget.reservations].reverse().find((item) =>
    item.ownerId === ownerId && item.status !== "released");
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

  async maybeReview(session: RuntimeSession, signal: AbortSignal, explicitlyRequested = false): Promise<void> {
    if (profileReviewMode(session) === "off") return;
    const existing = this.active.get(session.identity.sessionId);
    if (existing) return await existing;
    const task = this.reviewEligibleChange(session, signal, explicitlyRequested);
    this.active.set(session.identity.sessionId, task);
    try { await task; } finally {
      if (this.active.get(session.identity.sessionId) === task) this.active.delete(session.identity.sessionId);
    }
  }

  private async reviewEligibleChange(session: RuntimeSession, signal: AbortSignal, explicitlyRequested: boolean): Promise<void> {
    const { eligible, relevantValidations, retryableReview } = reviewReadiness(session);
    if (eligible.length === 0) return;
    const existing = currentFrontierReview(session);
    if (existing) {
      if (!(explicitlyRequested && retryableReview)) return;
      const frontier = session.durable.state.mutationFrontier;
      const attempts = session.durable.state.evidence.filter((item) => item.kind === "review"
        && item.data.frontierRevision === frontier.revision
        && item.data.stateDigest === frontier.currentStateDigest).length;
      if (attempts >= 2) return;
    }
    const reviewer = this.reviewerForSession(session);
    const reviewerId = reviewer.reviewerId ?? "builtin-reviewer";
    const frontier = session.durable.state.mutationFrontier;
    const input: ReviewerInput = {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      goal: session.durable.state.plan.goal,
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      workspaceDeltas: eligible,
      validations: relevantValidations
    };
    const requestId = requestIdentity(session, reviewerId);
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
        session, reviewInputFailureEvidence(input, reviewerId, inputProblem)
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
      validationEvidenceIds: relevantValidations.map((item) => item.evidenceId)
    });
    let raw: ReviewEvidence;
    try { raw = await reviewer.review(input, signal); } catch (error) {
      raw = failedReview(input, reviewerId,
        `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure");
    }
    await this.emit(session, "review.completed", "runtime", normalizeReview(session, raw));
  }

  private async reviewAccounted(session: RuntimeSession, reviewer: AccountableReviewerPort,
    reviewerId: string, input: ReviewerInput, requestId: string, signal: AbortSignal): Promise<void> {
    const remaining = Math.max(0, session.durable.state.budget.limits.costMicroUsd
      - session.durable.state.budget.consumed.costMicroUsd
      - session.durable.state.budget.reserved.costMicroUsd);
    const prepared = await reviewer.prepareReview(input, remaining);
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
      await this.emit(session, "review.completed", "runtime", normalizeReview(session, failedReview(
        input, reviewerId, `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure"
      )));
      return;
    }
    const usage = stableUsage(result.usage, requestId);
    await this.budgets!.commitMeasured(session, reservationId, consumedBudget(usage, prepared.budget));
    await this.emit(session, "usage.recorded", "runtime", usage);
    await this.emit(session, "review.completed", "runtime", normalizeReview(session, result.evidence));
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
    )));
  }
}
