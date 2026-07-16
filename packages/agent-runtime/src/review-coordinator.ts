import { createHash, randomUUID } from "node:crypto";
import {
  evidenceSupportsClaim,
  type BudgetReservation,
  type EvidenceRecord,
  type ReviewEvidence,
  type UsageRecord,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import { consumedBudget } from "./model-accounting.js";
import type { RuntimeSession } from "./types.js";
import {
  documentationOnly,
  isAccountableReviewer,
  reviewInputFailure,
  reviewInputFailureEvidence,
  type AccountableReviewerPort,
  type ReviewerInput,
  type ReviewerPort
} from "./reviewer.js";
import {
  latestValidationExecutionForDelta,
  validationExecutionCoversDelta
} from "./validation-policy.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { sessionMutationEvidence } from "./mutation-evidence.js";

function normalizeReview(
  session: RuntimeSession,
  raw: ReviewEvidence,
  workspaceDeltas: WorkspaceDeltaEvidence[],
  validations: ValidationEvidence[]
): ReviewEvidence {
  const verdict = raw.data.verdict === "approved" ? "approved" : "changes_requested";
  return {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: raw.data.reviewerId },
    summary: raw.summary,
    data: {
      reviewerId: raw.data.reviewerId,
      verdict,
      findings: [...raw.data.findings],
      workspaceDeltaEvidenceIds: workspaceDeltas.map((item) => item.evidenceId),
      validationEvidenceIds: validations.map((item) => item.evidenceId),
      ...(raw.data.failureKind ? { failureKind: raw.data.failureKind } : {}),
      ...(workspaceDeltas.at(-1)?.data.checkpointId
        ? { checkpointId: workspaceDeltas.at(-1)!.data.checkpointId } : {})
    }
  };
}

function failedReview(
  input: ReviewerInput,
  reviewerId: string,
  message: string,
  failureKind: "infrastructure" | "interrupted"
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
      reviewerId,
      verdict: "changes_requested",
      findings: [message],
      workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      failureKind
    }
  };
}

function sameIdSet(actualIds: readonly string[], expectedIds: readonly string[]): boolean {
  if (actualIds.length !== expectedIds.length) return false;
  const actual = new Set(actualIds);
  return expectedIds.every((id) => actual.has(id));
}

function sameReviewInput(
  item: EvidenceRecord,
  deltaIds: readonly string[],
  validationIds: readonly string[]
): boolean {
  if (item.kind !== "review" || !sameIdSet(item.data.workspaceDeltaEvidenceIds, deltaIds)) return false;
  // A legacy record cannot prove which validations were reviewed. Permit one
  // migration review; the newly emitted record then carries an exact input set
  // and restores the no-replay guarantee.
  return item.data.validationEvidenceIds !== undefined
    && sameIdSet(item.data.validationEvidenceIds, validationIds);
}

function requestIdentity(
  session: RuntimeSession,
  reviewerId: string,
  ids: readonly string[],
  evidence: readonly EvidenceRecord[]
): string {
  const attempt = evidence.filter((item) => item.kind === "review"
    && sameIdSet(item.data.workspaceDeltaEvidenceIds, ids)).length + 1;
  const digest = createHash("sha256").update(JSON.stringify({
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    reviewerId,
    ids: [...ids].sort(),
    attempt
  })).digest("hex");
  return `review:${digest}`;
}

function stableUsage(usage: UsageRecord, requestId: string): UsageRecord {
  return { ...usage, usageId: `${requestId}:usage`, requestId, role: "reviewer" };
}

function activeReservation(session: RuntimeSession, ownerId: string): BudgetReservation | undefined {
  return [...session.durable.state.budget.reservations].reverse().find((item) =>
    item.ownerId === ownerId && item.status !== "released");
}

function suppressDuplicateReview(
  evidence: readonly EvidenceRecord[],
  deltaIds: readonly string[],
  validationIds: readonly string[],
  retryableReview: ReviewEvidence | undefined,
  explicitlyRequested: boolean
): boolean {
  const matchingReviews = evidence.filter((item) => sameReviewInput(item, deltaIds, validationIds));
  const allowedRetryCount = explicitlyRequested && retryableReview ? 1 : 0;
  return matchingReviews.length > allowedRetryCount;
}

export interface ReviewReadiness {
  pending: WorkspaceDeltaEvidence[];
  eligible: WorkspaceDeltaEvidence[];
  validations: ValidationEvidence[];
  relevantValidations: ValidationEvidence[];
  blockedReview?: ReviewEvidence;
  retryableReview?: ReviewEvidence;
}

/** One authoritative selection policy shared by automatic and explicitly
 * requested internal review. Callers never supply or guess evidence IDs. */
export function reviewReadiness(session: RuntimeSession): ReviewReadiness {
  const evidence = sessionMutationEvidence(session);
  const waivedIds = reviewerWaivedDeltaIds(evidence);
  const validations = evidence.filter((item): item is ValidationEvidence =>
    item.kind === "validation" && evidenceSupportsClaim(item, "validation_executed"));
  const reviewedIds = new Set(evidence.flatMap((item) => {
    if (item.kind !== "review" || item.status !== "passed" || item.data.verdict !== "approved") return [];
    return item.data.workspaceDeltaEvidenceIds.filter((deltaId) => {
      const delta = evidence.find((candidate): candidate is WorkspaceDeltaEvidence =>
        candidate.kind === "workspace_delta" && candidate.evidenceId === deltaId);
      const latest = delta ? latestValidationExecutionForDelta(validations, delta) : undefined;
      return latest?.status !== "failed" || item.data.validationEvidenceIds?.includes(latest.evidenceId);
    });
  }));
  const pending = evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed"
    && !documentationOnly(item) && !reviewedIds.has(item.evidenceId) && !waivedIds.has(item.evidenceId));
  const eligible = pending.filter((delta) => validations.some((validation) =>
    validationExecutionCoversDelta(validation, delta)));
  const eligibleIds = new Set(eligible.map((item) => item.evidenceId));
  const relevantValidations = validations.filter((item) =>
    item.data.workspaceDeltaEvidenceIds.some((evidenceId) => eligibleIds.has(evidenceId)));
  const latestFailedReview = evidence.filter((item): item is ReviewEvidence =>
    item.kind === "review" && item.status === "failed" && sameReviewInput(
      item,
      [...eligibleIds],
      relevantValidations.map((validation) => validation.evidenceId)
    )).at(-1);
  const retryableReview = latestFailedReview?.data.failureKind ? latestFailedReview : undefined;
  const blockedReview = latestFailedReview && !latestFailedReview.data.failureKind
    ? latestFailedReview : undefined;
  return {
    pending,
    eligible,
    validations,
    relevantValidations,
    ...(blockedReview ? { blockedReview } : {}),
    ...(retryableReview ? { retryableReview } : {})
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

  async maybeReview(session: RuntimeSession, signal: AbortSignal, explicitlyRequested = false): Promise<void> {
    const existing = this.active.get(session.identity.sessionId);
    if (existing) return await existing;
    const task = this.reviewEligibleChange(session, signal, explicitlyRequested);
    this.active.set(session.identity.sessionId, task);
    try { await task; } finally {
      if (this.active.get(session.identity.sessionId) === task) this.active.delete(session.identity.sessionId);
    }
  }

  private async reviewEligibleChange(
    session: RuntimeSession,
    signal: AbortSignal,
    explicitlyRequested: boolean
  ): Promise<void> {
    const evidence = sessionMutationEvidence(session);
    const { eligible, relevantValidations, blockedReview, retryableReview } = reviewReadiness(session);
    if (eligible.length === 0) return;
    const eligibleIds = new Set(eligible.map((item) => item.evidenceId));
    if (blockedReview || (retryableReview && !explicitlyRequested)) return;
    const reviewer = this.reviewerForSession(session);
    const reviewerId = reviewer.reviewerId ?? "builtin-reviewer";
    const input: ReviewerInput = {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      goal: session.durable.state.plan.goal,
      workspaceDeltas: eligible,
      validations: relevantValidations
    };
    // An interrupted accountable review has a durable reservation that must
    // be recovered before input validation or duplicate suppression.
    if (await this.recoverActiveAccountableReview(
      session, reviewer, reviewerId, input, evidence, signal
    )) return;
    const inputProblem = reviewInputFailure(input);
    if (inputProblem) {
      await this.emit(session, "review.completed", "runtime", normalizeReview(
        session,
        reviewInputFailureEvidence(input, reviewerId, inputProblem),
        eligible,
        relevantValidations
      ));
      return;
    }
    // A review is keyed by the exact workspace-delta and validation evidence
    // it consumed. Re-requesting the same input cannot add information and
    // only creates duplicate reviewer calls; any new evidence ID naturally
    // produces a different input and remains eligible.
    // Preserve the established explicit one-time retry for a retryable
    // infrastructure review. Once that retry is recorded, further requests
    // with the same evidence are duplicates until a new delta/validation ID
    // appears.
    if (suppressDuplicateReview(
      evidence,
      [...eligibleIds],
      relevantValidations.map((validation) => validation.evidenceId),
      retryableReview,
      explicitlyRequested
    )) return;
    if (this.budgets && isAccountableReviewer(reviewer)) {
      await this.reviewAccounted(session, reviewer, reviewerId, input, evidence, signal);
      return;
    }
    await this.emit(session, "review.started", "runtime", {
      reviewerId,
      workspaceDeltaEvidenceIds: [...eligibleIds],
      validationEvidenceIds: relevantValidations.map((item) => item.evidenceId)
    });
    let rawReview: ReviewEvidence;
    try {
      rawReview = await reviewer.review(input, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rawReview = failedReview(
        input,
        reviewerId,
        `Independent reviewer failed: ${message}`,
        "infrastructure"
      );
    }
    await this.emit(session, "review.completed", "runtime", normalizeReview(
      session, rawReview, eligible, relevantValidations
    ));
  }

  private async recoverActiveAccountableReview(
    session: RuntimeSession,
    reviewer: ReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    evidence: readonly EvidenceRecord[],
    signal: AbortSignal
  ): Promise<boolean> {
    if (!this.budgets || !isAccountableReviewer(reviewer)) return false;
    const requestId = requestIdentity(
      session,
      reviewerId,
      input.workspaceDeltas.map((item) => item.evidenceId),
      evidence
    );
    if (!activeReservation(session, `reviewer:${requestId}`)) return false;
    await this.reviewAccounted(session, reviewer, reviewerId, input, evidence, signal);
    return true;
  }

  private async reviewAccounted(
    session: RuntimeSession,
    reviewer: AccountableReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    evidence: readonly EvidenceRecord[],
    signal: AbortSignal
  ): Promise<void> {
    const ids = input.workspaceDeltas.map((item) => item.evidenceId);
    const requestId = requestIdentity(session, reviewerId, ids, evidence);
    const ownerId = `reviewer:${requestId}`;
    const prior = activeReservation(session, ownerId);
    if (prior) {
      await this.recoverInterruptedReview(session, reviewer, reviewerId, input, requestId, prior);
      return;
    }
    const remainingCost = Math.max(0, session.durable.state.budget.limits.costMicroUsd
      - session.durable.state.budget.consumed.costMicroUsd
      - session.durable.state.budget.reserved.costMicroUsd);
    const prepared = await reviewer.prepareReview(input, remainingCost);
    const reservationId = await this.budgets!.reserve(session, ownerId, prepared.budget.reserved);
    await this.emit(session, "review.started", "runtime", {
      reviewerId,
      requestId,
      workspaceDeltaEvidenceIds: ids,
      validationEvidenceIds: input.validations.map((item) => item.evidenceId)
    });
    const startedAt = performance.now();
    let result;
    try {
      signal.throwIfAborted();
      result = await reviewer.reviewPrepared(input, requestId, prepared, signal);
    } catch (error) {
      const usage = stableUsage(reviewer.failedUsage(
        input, requestId, prepared, performance.now() - startedAt, error
      ), requestId);
      await this.budgets!.commit(session, reservationId, consumedBudget(usage, prepared.budget));
      await this.emit(session, "usage.recorded", "runtime", usage);
      const message = error instanceof Error ? error.message : String(error);
      await this.emit(session, "review.completed", "runtime", normalizeReview(
        session,
        failedReview(input, reviewerId, `Independent reviewer failed: ${message}`, "infrastructure"),
        input.workspaceDeltas,
        input.validations
      ));
      return;
    }
    const usage = stableUsage(result.usage, requestId);
    await this.budgets!.commitMeasured(session, reservationId, consumedBudget(usage, prepared.budget));
    await this.emit(session, "usage.recorded", "runtime", usage);
    await this.emit(session, "review.completed", "runtime", normalizeReview(
      session, result.evidence, input.workspaceDeltas, input.validations
    ));
  }

  private async recoverInterruptedReview(
    session: RuntimeSession,
    reviewer: AccountableReviewerPort,
    reviewerId: string,
    input: ReviewerInput,
    requestId: string,
    reservation: BudgetReservation
  ): Promise<void> {
    const amounts = reservation.status === "reserved" ? reservation.requested : reservation.consumed;
    if (reservation.status === "reserved") {
      await this.budgets!.commit(session, reservation.reservationId, amounts);
    }
    if (!session.durable.state.usage.some((item) => item.requestId === requestId && item.role === "reviewer")) {
      await this.emit(session, "usage.recorded", "runtime", stableUsage(
        reviewer.recoveredUsage(input, requestId, amounts), requestId
      ));
    }
    await this.emit(session, "review.completed", "runtime", normalizeReview(
      session,
      failedReview(
        input,
        reviewerId,
        "Independent review was interrupted; the model call was not replayed.",
        "interrupted"
      ),
      input.workspaceDeltas,
      input.validations
    ));
  }
}
