import type { BudgetAmounts } from "agent-protocol";
import { APPROXIMATE_TOKEN_RESERVATION_MARGIN } from "agent-model";
import type { PreparedModelBudget } from "./model-accounting.js";
import { fitPreparedBudget } from "./model-budget-convergence.js";
import type { PreparedReviewerCall } from "./reviewer-contracts.js";

const MODEL_BUDGET_DIMENSIONS = [
  "inputTokens",
  "outputTokens",
  "costMicroUsd",
  "modelTurns"
] as const;

type ModelBudgetDimension = typeof MODEL_BUDGET_DIMENSIONS[number];

function amount(
  budget: Partial<BudgetAmounts>,
  dimension: ModelBudgetDimension
): number {
  return budget[dimension] ?? 0;
}

function fits(
  requested: Partial<BudgetAmounts>,
  available: BudgetAmounts
): boolean {
  return MODEL_BUDGET_DIMENSIONS.every((dimension) =>
    amount(requested, dimension) <= available[dimension]);
}

function logicalTurnReservation(
  turnBudget: PreparedModelBudget,
  turnIndex: number
): Partial<BudgetAmounts> {
  // Later turns replay the review request plus bounded inspection receipts.
  // The two-times envelope matches the previous aggregate reservation without
  // forcing every configured turn to fit before the first review can start.
  const replayGrowth = turnIndex === 0 ? 1 : 2;
  return {
    inputTokens: Math.ceil(amount(turnBudget.reserved, "inputTokens") * replayGrowth),
    outputTokens: amount(turnBudget.reserved, "outputTokens"),
    costMicroUsd: Math.ceil(amount(turnBudget.reserved, "costMicroUsd") * replayGrowth),
    modelTurns: amount(turnBudget.reserved, "modelTurns")
  };
}

export function aggregateReviewerBudget(
  turnBudget: PreparedModelBudget,
  maxTurns: number
): PreparedModelBudget {
  const turns = Math.max(1, Math.trunc(maxTurns));
  if (turns === 1) return turnBudget;
  const totals: Record<ModelBudgetDimension, number> = {
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    modelTurns: 0
  };
  for (let turn = 0; turn < turns; turn += 1) {
    const reservation = logicalTurnReservation(turnBudget, turn);
    for (const dimension of MODEL_BUDGET_DIMENSIONS) {
      totals[dimension] += amount(reservation, dimension);
    }
  }
  return {
    estimatedInputTokens: Math.max(1, totals.inputTokens),
    reserved: totals,
    reservedAttempts: Math.max(1, totals.modelTurns),
    ...(turnBudget.spec ? { spec: turnBudget.spec } : {})
  };
}

function inspectionCapable(prepared: PreparedReviewerCall): boolean {
  return (prepared.tools ?? []).some((tool) =>
    tool.name !== "submit_verification" && tool.name !== "submit_review");
}

interface FittedReviewerCandidate {
  call: PreparedReviewerCall;
  routeAttempts: number;
  interactive: boolean;
}

function preferCandidate(
  candidate: FittedReviewerCandidate,
  current: FittedReviewerCandidate | undefined
): boolean {
  if (!current) return true;
  if (candidate.interactive !== current.interactive) return candidate.interactive;
  if (candidate.routeAttempts !== current.routeAttempts) {
    return candidate.routeAttempts > current.routeAttempts;
  }
  return (candidate.call.maxTurns ?? 1) > (current.call.maxTurns ?? 1);
}

function fittedLogicalTurns(
  turnBudget: PreparedModelBudget,
  available: BudgetAmounts,
  requestedTurns: number
): { budget: PreparedModelBudget; turns: number } | undefined {
  let selected: { budget: PreparedModelBudget; turns: number } | undefined;
  for (let turns = 1; turns <= requestedTurns; turns += 1) {
    const budget = aggregateReviewerBudget(turnBudget, turns);
    if (!fits(budget.reserved, available)) break;
    selected = { budget, turns };
  }
  return selected;
}

function fittedCandidate(
  prepared: PreparedReviewerCall,
  originalTurnBudget: PreparedModelBudget,
  available: BudgetAmounts,
  requestedTurns: number,
  attempts: number,
  needsInspectionTurn: boolean
): FittedReviewerCandidate | undefined {
  const turnBudget = fitPreparedBudget(originalTurnBudget, available, attempts);
  if (!turnBudget) return undefined;
  const logical = fittedLogicalTurns(turnBudget, available, requestedTurns);
  if (!logical) return undefined;
  return {
    routeAttempts: turnBudget.reservedAttempts,
    interactive: !needsInspectionTurn || logical.turns >= 2,
    call: {
      ...prepared,
      maxTurns: logical.turns,
      turnBudget,
      budget: logical.budget
    }
  };
}

/**
 * Fit a review by logical turns while preserving the per-call provider retry
 * plan. This lets a smaller but still independent review run when the
 * protected pool cannot fund the configured worst-case conversation.
 */
export function fitPreparedReviewerCall(
  prepared: PreparedReviewerCall,
  available: BudgetAmounts,
  maxTurns: number
): PreparedReviewerCall | null {
  const requestedTurns = Math.max(1, Math.min(
    Math.trunc(maxTurns),
    Math.trunc(prepared.maxTurns ?? 1)
  ));
  const originalTurnBudget = prepared.turnBudget;
  if (!originalTurnBudget) {
    const budget = fitPreparedBudget(prepared.budget, available, maxTurns);
    return budget ? { ...prepared, budget } : null;
  }

  const maximumRouteAttempts = Math.max(
    1,
    originalTurnBudget.attemptReservations?.length
      ?? originalTurnBudget.reservedAttempts
  );
  const needsInspectionTurn = inspectionCapable(prepared) && requestedTurns >= 2;
  let best: FittedReviewerCandidate | undefined;
  let priorAttemptCount = -1;
  for (let attempts = maximumRouteAttempts; attempts >= 1; attempts -= 1) {
    const candidate = fittedCandidate(
      prepared,
      originalTurnBudget,
      available,
      requestedTurns,
      attempts,
      needsInspectionTurn
    );
    if (!candidate || candidate.routeAttempts === priorAttemptCount) continue;
    priorAttemptCount = candidate.routeAttempts;
    if (preferCandidate(candidate, best)) best = candidate;
    if (!originalTurnBudget.attemptReservations) break;
  }
  return best?.call ?? null;
}

export function affordableReviewerOutputLimit(
  availableOutputTokens: number,
  desiredOutputTokens = 2_048
): number {
  const affordable = Math.floor(
    Math.max(0, availableOutputTokens) / APPROXIMATE_TOKEN_RESERVATION_MARGIN
  );
  return Math.max(1, Math.min(desiredOutputTokens, affordable));
}
