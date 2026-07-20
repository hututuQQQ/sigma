import type { BudgetAmounts } from "agent-protocol";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { candidateReviewEligible } from "./review-eligibility.js";
import { completionReviewerInput } from "./review-coordinator.js";
import {
  COMPLETION_REVIEW_OUTPUT_TOKENS,
  canQuoteCompletionReserve,
  isAccountableReviewer,
  reviewInputFailure,
  type CompletionReviewCandidateV1,
  type ReviewerPort
} from "./reviewer.js";
import type { RuntimeSession } from "./types.js";

const EMPTY_BUDGET: BudgetAmounts = {
  inputTokens: 0, outputTokens: 0, costMicroUsd: 0,
  modelTurns: 0, toolCalls: 0, children: 0
};

export class CompletionReserveQuoteUnavailableError extends Error {
  readonly code = "review_budget_quote_unavailable";
}

function completeBudgetAmounts(value: Partial<BudgetAmounts>): BudgetAmounts {
  return {
    ...EMPTY_BUDGET,
    inputTokens: value.inputTokens ?? 0,
    outputTokens: value.outputTokens ?? 0,
    costMicroUsd: value.costMicroUsd ?? 0,
    modelTurns: value.modelTurns ?? 0
  };
}

export function reviewerForSession(options: EffectRunnerOptions, session: RuntimeSession): ReviewerPort {
  return options.reviewerForSession?.(session) ?? options.reviewer;
}

/** Quote the reviewer from its own accounting contract before admitting the
 * solver request. Non-accountable reviewers consume deadline, but no durable
 * model budget. */
export async function candidateReviewerBudgetReserve(
  session: RuntimeSession,
  reviewer: ReviewerPort,
  remainingBudgetMicroUsd: number
): Promise<BudgetAmounts> {
  if (!candidateReviewEligible(session) || !isAccountableReviewer(reviewer)) return { ...EMPTY_BUDGET };
  if (!canQuoteCompletionReserve(reviewer)) {
    throw new CompletionReserveQuoteUnavailableError(
      "The accountable reviewer cannot quote the bounded completion candidate envelope."
    );
  }
  const emptyCandidate: CompletionReviewCandidateV1 = { message: "", summary: "", warnings: [] };
  const input = completionReviewerInput(session, emptyCandidate);
  if (reviewInputFailure(input)) return { ...EMPTY_BUDGET };
  try {
    const budget = await reviewer.prepareCompletionReserve(
      input, remainingBudgetMicroUsd, COMPLETION_REVIEW_OUTPUT_TOKENS
    );
    return completeBudgetAmounts(budget.reserved);
  } catch (error) {
    throw new CompletionReserveQuoteUnavailableError(
      `The completion reviewer could not quote its bounded request: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
