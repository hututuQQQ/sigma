import type { ToolReceipt } from "agent-protocol";
import { parseCompletionProposal } from "agent-tools";
import { assuranceRequirement } from "./assurance-engine.js";
import { completionPlan } from "./completion-evidence-gate.js";
import { runtimeSignal, shouldReviewReceipt } from "./effect-receipt-helpers.js";
import { currentFrontierReview } from "./mutation-evidence.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import {
  COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES,
  COMPLETION_CANDIDATE_MAX_TEXT_CODE_UNITS,
  COMPLETION_CANDIDATE_MAX_WARNINGS,
  completionCandidateEnvelopeFailure,
  completionCandidateDigest,
  type CompletionCandidateEnvelopeFailureV1,
  type CompletionReviewCandidateV1
} from "./completion-review-candidate.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import type { RuntimeSession } from "./types.js";
import { candidateReviewEligible } from "./review-eligibility.js";

export type ReviewMode = "off" | "advisory" | "required";

interface CompletionReceiptReviewerOptions {
  emit: RuntimeEventEmitter;
  control: RuntimeControlService;
  hooks: RuntimeHookCoordinator;
}

function completionCandidate(
  session: RuntimeSession,
  callId: string
): CompletionReviewCandidateV1 | undefined {
  const pending = session.durable.state.pendingTools.find((item) => item.request.callId === callId);
  const proposal = pending ? parseCompletionProposal(pending.request.arguments) : null;
  if (!proposal) return undefined;
  const sameTurn = [...session.durable.state.messages].reverse().find((message) =>
    message.role === "assistant" && message.toolCalls?.some((call) => call.id === callId))?.content.trim();
  const repair = session.durable.state.completionRepair;
  const protectedAnswer = repair && "answer" in repair ? repair.answer.trim() : "";
  const answer = protectedAnswer || sameTurn || "";
  const summary = proposal.warnings?.length
    ? `${proposal.summary}\n\nWarnings:\n${proposal.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : proposal.summary;
  const message = !answer || answer.includes(summary) ? answer || summary
    : summary.includes(answer) ? summary : `${answer}\n\nResult: ${summary}`;
  return { message, summary: proposal.summary, warnings: proposal.warnings ?? [] };
}

function rejectedReceipt(
  receipt: ToolReceipt,
  findings: readonly unknown[],
  currentReviewExists: boolean
): ToolReceipt {
  return {
    ...receipt,
    ok: false,
    output: findings.length > 0
      ? `Independent review did not approve the completion candidate: ${findings.map(String).join("; ")}`
      : "Independent review did not approve the completion candidate.",
    observedEffects: [],
    actualEffects: [],
    diagnostics: [...new Set([...receipt.diagnostics, "review_evidence_required"])],
    result: {
      status: "rejected",
      code: "review_evidence_required",
      reviewState: currentReviewExists ? "current" : "none"
    }
  };
}

function envelopeRejectedReceipt(
  receipt: ToolReceipt,
  failure: CompletionCandidateEnvelopeFailureV1
): ToolReceipt {
  return {
    ...receipt,
    ok: false,
    output: failure.message,
    observedEffects: [],
    actualEffects: [],
    diagnostics: [...new Set([...receipt.diagnostics, failure.code])],
    result: {
      status: "rejected",
      code: failure.code,
      serializedUtf8Bytes: failure.serializedUtf8Bytes,
      textCodeUnits: failure.textCodeUnits,
      warningCount: failure.warningCount,
      limits: {
        serializedUtf8Bytes: COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES,
        textCodeUnits: COMPLETION_CANDIDATE_MAX_TEXT_CODE_UNITS,
        warningCount: COMPLETION_CANDIDATE_MAX_WARNINGS
      }
    }
  };
}

function strictReviewRequired(session: RuntimeSession, mode: ReviewMode): boolean {
  return mode === "required" || assuranceRequirement(session).review === "required";
}

function candidateReview(
  session: RuntimeSession,
  candidate: CompletionReviewCandidateV1 | undefined
): ReturnType<typeof currentFrontierReview> {
  return candidate
    ? currentFrontierReview(session, completionCandidateDigest(candidate))
    : currentFrontierReview(session);
}

function applicableCandidateReview(
  session: RuntimeSession,
  candidate: CompletionReviewCandidateV1 | undefined,
  eligible: boolean
): ReturnType<typeof currentFrontierReview> {
  return eligible ? candidateReview(session, candidate) : undefined;
}

function missingRequiredApproval(
  session: RuntimeSession,
  mode: ReviewMode,
  approved: boolean
): boolean {
  return strictReviewRequired(session, mode)
    && session.durable.state.mutationFrontier.changedPaths.length > 0
    && !approved;
}

export class CompletionReceiptReviewer {
  constructor(
    private readonly options: CompletionReceiptReviewerOptions,
    private readonly reviewCoordinator: () => ReviewCoordinator
  ) {}

  private get reviews(): ReviewCoordinator { return this.reviewCoordinator(); }

  async beforeReceipt(
    session: RuntimeSession,
    receipt: ToolReceipt,
    name: string,
    reviewMode: ReviewMode,
    signal: AbortSignal
  ): Promise<{ receipt: ToolReceipt; reviewed: boolean }> {
    if (name === "request_review") return await this.requestReviewReceipt(session, receipt);
    if (!receipt.ok) return { receipt, reviewed: false };
    if (name !== "runtime_finalize") return { receipt, reviewed: false };
    return await this.completionReceiptAfterReview(session, receipt, reviewMode, signal);
  }

  async afterReceipt(
    session: RuntimeSession,
    name: string,
    reviewMode: ReviewMode,
    reviewedBefore: boolean
  ): Promise<void> {
    if (reviewedBefore || !shouldReviewReceipt(name, reviewMode)) return;
    await this.reviews.maybeReview(session, runtimeSignal(session), name === "request_review");
  }

  private async requestReviewReceipt(
    session: RuntimeSession,
    receipt: ToolReceipt
  ): Promise<{ receipt: ToolReceipt; reviewed: true }> {
    await this.reviews.maybeReview(session, runtimeSignal(session), true);
    const result = await this.options.control.forSession(session).requestReview();
    const blocked = result.status === "validation_required" || result.status === "changes_required";
    const reviewDiagnostics = new Set(["review_validation_required", "review_changes_required"]);
    const diagnostics = receipt.diagnostics.filter((item) => !reviewDiagnostics.has(item));
    if (blocked) diagnostics.push(result.status === "validation_required"
      ? "review_validation_required" : "review_changes_required");
    return {
      receipt: {
        ...receipt,
        ok: !blocked,
        output: JSON.stringify(result),
        diagnostics
      },
      reviewed: true
    };
  }

  private async completionReceiptAfterReview(
    session: RuntimeSession,
    receipt: ToolReceipt,
    reviewMode: ReviewMode,
    signal: AbortSignal
  ): Promise<{ receipt: ToolReceipt; reviewed: boolean }> {
    const candidate = completionCandidate(session, receipt.callId);
    const reviewEligible = candidate !== undefined && candidateReviewEligible(session);
    const envelopeFailure = reviewEligible ? completionCandidateEnvelopeFailure(candidate) : undefined;
    if (envelopeFailure) {
      return { reviewed: true, receipt: envelopeRejectedReceipt(receipt, envelopeFailure) };
    }
    if (reviewMode !== "off" && candidate && reviewEligible) {
      await this.reviews.maybeReview(session, runtimeSignal(session), false, candidate);
    }
    // Once a subject is absent or explicitly waived, a prior candidate-bound
    // rejection is no longer a completion obligation for this delivery.
    const review = applicableCandidateReview(session, candidate, reviewEligible);
    const approved = review?.status === "passed" && review.data.verdict === "approved";
    if (missingRequiredApproval(session, reviewMode, approved)) {
      return {
        reviewed: true,
        receipt: rejectedReceipt(receipt, review?.data.findings ?? [], review !== undefined)
      };
    }
    // A failed review of any kind leaves the plan open. In particular, an
    // infrastructure/interruption result is not approval and must not make a
    // subsequent repair impossible by closing the editable plan.
    if (reviewMode === "off" || review === undefined || approved) {
      await this.commitCompletionPlan(session, signal);
    }
    return { receipt, reviewed: reviewMode !== "off" };
  }

  private async commitCompletionPlan(session: RuntimeSession, signal: AbortSignal): Promise<void> {
    const completed = completionPlan(session);
    if (!completed) return;
    const previousRevision = session.durable.state.plan.revision;
    await this.options.emit(session, "plan.updated", "runtime", { previousRevision, plan: completed });
    await this.options.hooks.dispatch(session, "plan_changed", {
      previousRevision, plan: completed, source: "completion"
    }, signal);
  }
}
