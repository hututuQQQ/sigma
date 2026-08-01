import type {
  BudgetReservation,
  ReviewEvidence,
  UsageRecord
} from "agent-protocol";
import { availableAuxiliaryBudget } from "./assurance-budget.js";
import type { BudgetController } from "./budget-controller.js";
import { consumedBudget } from "./model-accounting.js";
import {
  affordableReviewerOutputLimit,
  fitPreparedReviewerCall
} from "./reviewer-budget.js";
import {
  activeReservation,
  eligibleReviewAttempt,
  failedReview,
  profileReviewMode,
  requestIdentity,
  reviewerInput,
  stableUsage
} from "./review-coordinator-support.js";
import { normalizeReview } from "./review-normalization.js";
import {
  isAccountableReviewer,
  type AccountableReviewerPort,
  type ReviewerInput,
  type ReviewerPort
} from "./reviewer.js";
import { reviewInputFailure } from "./review-evidence-preflight.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

export {
  reviewReadiness,
  type ReviewReadiness
} from "./review-coordinator-support.js";
export { goalReferencedWorkspaceReads } from "./reviewer-workspace-reads.js";

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
    const existing = this.active.get(session.identity.sessionId);
    if (existing) return await existing;
    const task = this.reviewEligibleChange(
      session,
      signal,
      explicitlyRequested,
      reviewMode
    );
    this.active.set(session.identity.sessionId, task);
    try {
      await task;
    } finally {
      if (this.active.get(session.identity.sessionId) === task) {
        this.active.delete(session.identity.sessionId);
      }
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
    const requestId = requestIdentity(
      session,
      reviewerId,
      attempt.basisDigest,
      attempt.basisAttempts + 1
    );
    if (await this.recoverActiveReview(
      session,
      reviewer,
      reviewerId,
      input,
      requestId
    )) return;
    const inputProblem = reviewInputFailure(input);
    if (inputProblem) await this.emit(session, "evidence.recorded", "runtime", {
      evidenceId: `review-preflight:${requestId}`,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "diagnostic",
      status: "informational",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "review-preflight" },
      summary: "Independent verification input has a non-terminal integrity diagnostic.",
      data: {
        source: "review_preflight",
        diagnostic: { message: inputProblem }
      }
    });
    if (this.budgets && isAccountableReviewer(reviewer)) {
      await this.reviewAccounted(session, reviewer, reviewerId, input, requestId, signal);
    } else {
      await this.reviewUnaccounted(session, reviewer, reviewerId, input, requestId, signal);
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
    await this.recoverInterruptedReview(
      session,
      reviewer,
      reviewerId,
      input,
      requestId,
      prior
    );
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
    await this.emitReviewStarted(session, reviewerId, requestId, input);
    let raw: ReviewEvidence;
    try {
      raw = await reviewer.review(input, signal);
    } catch (error) {
      raw = failedReview(
        input,
        reviewerId,
        `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
        "infrastructure"
      );
    }
    const normalized = normalizeReview(
      session,
      raw,
      input.reviewBasisDigest,
      input.completionCandidateDigest,
      requestId
    );
    await this.emit(session, "review.completed", "runtime", normalized);
    return normalized;
  }

  private async reviewAccounted(
    session: RuntimeSession,
    reviewer: AccountableReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    requestId: string,
    signal: AbortSignal
  ): Promise<ReviewEvidence> {
    const prepared = await this.prepareAccountedReview(
      session,
      reviewer,
      reviewerId,
      input
    );
    if (!prepared) {
      return session.durable.state.evidence.filter(
        (item): item is ReviewEvidence => item.kind === "review"
      ).at(-1)!;
    }
    const reservationId = await this.budgets!.reserve(
      session,
      `reviewer:${requestId}`,
      prepared.budget.reserved
    );
    await this.emitReviewStarted(session, reviewerId, requestId, input);
    const startedAt = performance.now();
    let evidence: ReviewEvidence;
    let usage: UsageRecord;
    try {
      const result = await reviewer.reviewPrepared(
        input,
        requestId,
        prepared,
        signal
      );
      usage = stableUsage(result.usage, requestId);
      evidence = result.evidence;
    } catch (error) {
      usage = stableUsage(
        reviewer.failedUsage(
          input,
          requestId,
          prepared,
          performance.now() - startedAt,
          error
        ),
        requestId
      );
      evidence = failedReview(
        input,
        reviewerId,
        `Independent reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
        "infrastructure"
      );
    }
    await this.budgets!.commitMeasured(
      session,
      reservationId,
      consumedBudget(usage, prepared.budget)
    );
    await this.emit(session, "usage.recorded", "runtime", usage);
    const normalized = normalizeReview(
      session,
      evidence,
      input.reviewBasisDigest,
      input.completionCandidateDigest,
      requestId
    );
    await this.emit(session, "review.completed", "runtime", normalized);
    return normalized;
  }

  private async prepareAccountedReview(
    session: RuntimeSession,
    reviewer: AccountableReviewerPort,
    reviewerId: string,
    input: ReviewerInput
  ): Promise<Awaited<ReturnType<AccountableReviewerPort["prepareReview"]>> | undefined> {
    const auxiliary = availableAuxiliaryBudget(session);
    const reviewerMaxTurns = session.durable.state.longHorizon.assurance.reviewerMaxTurns;
    let outputLimit = affordableReviewerOutputLimit(auxiliary.outputTokens);
    let passiveFallback: Awaited<ReturnType<AccountableReviewerPort["prepareReview"]>> | undefined;
    let preparationFailure: unknown;
    while (true) {
      let prepared: Awaited<ReturnType<AccountableReviewerPort["prepareReview"]>>;
      try {
        prepared = await reviewer.prepareReview(
          input,
          auxiliary.costMicroUsd,
          outputLimit
        );
      } catch (error) {
        preparationFailure = error;
        break;
      }
      const fitted = fitPreparedReviewerCall(
        prepared,
        auxiliary,
        reviewerMaxTurns
      );
      if (fitted) {
        const inspectionCapable = (prepared.tools ?? []).some((tool) =>
          tool.name !== "submit_verification" && tool.name !== "submit_review");
        if (!inspectionCapable || (fitted.maxTurns ?? 1) >= 2) return fitted;
        passiveFallback ??= fitted;
      }
      if (outputLimit <= 256) break;
      outputLimit = Math.max(256, Math.floor(outputLimit / 2));
    }
    if (passiveFallback) return passiveFallback;
    await this.emitUnavailableReview(
      session,
      input,
      reviewerId,
      preparationFailure
        ? `Independent reviewer could not be prepared within the assurance pool: ${preparationFailure instanceof Error ? preparationFailure.message : String(preparationFailure)}`
        : "The protected assurance pool cannot fund an independent completion review."
    );
    return undefined;
  }

  private async emitUnavailableReview(
    session: RuntimeSession,
    input: ReviewerInput,
    reviewerId: string,
    message: string
  ): Promise<void> {
    const normalized = normalizeReview(
      session,
      failedReview(
        input,
        reviewerId,
        message,
        "infrastructure",
        "review_unavailable"
      ),
      input.reviewBasisDigest,
      input.completionCandidateDigest
    );
    await this.emit(session, "review.completed", "runtime", normalized);
  }

  private async emitReviewStarted(
    session: RuntimeSession,
    reviewerId: string,
    requestId: string,
    input: ReviewerInput
  ): Promise<void> {
    await this.emit(session, "review.started", "runtime", {
      reviewerId,
      requestId,
      workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId)
    });
  }

  private async recoverInterruptedReview(
    session: RuntimeSession,
    reviewer: AccountableReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    requestId: string,
    reservation: BudgetReservation
  ): Promise<void> {
    const amounts = reservation.status === "reserved"
      ? reservation.requested
      : reservation.consumed;
    if (reservation.status === "reserved") {
      await this.budgets!.commit(session, reservation.reservationId, amounts);
    }
    if (!session.durable.state.usage.some((item) =>
      item.requestId === requestId && item.role === "reviewer")) {
      await this.emit(
        session,
        "usage.recorded",
        "runtime",
        stableUsage(reviewer.recoveredUsage(input, requestId, amounts), requestId)
      );
    }
    await this.emit(session, "review.completed", "runtime", normalizeReview(
      session,
      failedReview(
        input,
        reviewerId,
        "Independent review was interrupted; the model call was not replayed.",
        "interrupted"
      ),
      input.reviewBasisDigest,
      input.completionCandidateDigest,
      requestId
    ));
  }
}
