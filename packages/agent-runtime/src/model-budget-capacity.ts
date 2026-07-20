import type { BudgetAmounts } from "agent-protocol";
import type { PreparedModelBudget } from "./model-accounting.js";

function firstAttemptBudget(prepared: PreparedModelBudget): Partial<BudgetAmounts> {
  const attempt = prepared.attemptReservations?.[0];
  return attempt ? {
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costMicroUsd: attempt.costMicroUsd ?? 0,
    modelTurns: 1
  } : prepared.reserved;
}

/** A completion candidate is produced by one routed attempt. Quote against the
 * largest output reservation among every fallback attempt that may execute. */
export function maximumAttemptOutputTokens(prepared: PreparedModelBudget): number {
  const attempts = prepared.attemptReservations ?? [];
  return attempts.length > 0
    ? Math.max(...attempts.map((attempt) => attempt.outputTokens))
    : prepared.reserved.outputTokens ?? 0;
}

function availableAfterReserve(
  available: BudgetAmounts,
  futureReserve: Partial<BudgetAmounts>
): BudgetAmounts {
  return {
    ...available,
    inputTokens: Math.max(0, available.inputTokens - (futureReserve.inputTokens ?? 0)),
    outputTokens: Math.max(0, available.outputTokens - (futureReserve.outputTokens ?? 0)),
    costMicroUsd: Math.max(0, available.costMicroUsd - (futureReserve.costMicroUsd ?? 0)),
    modelTurns: Math.max(0, available.modelTurns - (futureReserve.modelTurns ?? 0))
  };
}

export function requestCapacity(
  available: BudgetAmounts,
  prepared: PreparedModelBudget,
  futureReserve: Partial<BudgetAmounts> = {}
): number {
  const unit = firstAttemptBudget(prepared);
  const spendable = availableAfterReserve(available, futureReserve);
  const dimensions = ["inputTokens", "outputTokens", "costMicroUsd", "modelTurns"] as const;
  return Math.max(0, Math.min(3, ...dimensions.map((dimension) => {
    const required = unit[dimension] ?? 0;
    return required <= 0 ? Number.POSITIVE_INFINITY : Math.floor(spendable[dimension] / required);
  })));
}

export function fitPreparedBudget(
  prepared: PreparedModelBudget,
  available: BudgetAmounts,
  maxAttempts: number,
  futureReserve: Partial<BudgetAmounts> = {}
): PreparedModelBudget | null {
  const spendable = availableAfterReserve(available, futureReserve);
  const attempts = prepared.attemptReservations;
  if (!attempts || attempts.length === 0) {
    const fits = (["inputTokens", "outputTokens", "costMicroUsd", "modelTurns"] as const)
      .every((dimension) => (prepared.reserved[dimension] ?? 0) <= spendable[dimension]);
    return fits ? prepared : null;
  }
  const selected = [];
  const totals = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0 };
  for (const attempt of attempts.slice(0, maxAttempts)) {
    const next = {
      inputTokens: totals.inputTokens + attempt.inputTokens,
      outputTokens: totals.outputTokens + attempt.outputTokens,
      costMicroUsd: totals.costMicroUsd + (attempt.costMicroUsd ?? 0),
      modelTurns: totals.modelTurns + 1
    };
    if (next.inputTokens > spendable.inputTokens || next.outputTokens > spendable.outputTokens
      || next.costMicroUsd > spendable.costMicroUsd || next.modelTurns > spendable.modelTurns) break;
    selected.push(attempt);
    Object.assign(totals, next);
  }
  if (selected.length === 0) return null;
  return {
    ...prepared,
    estimatedInputTokens: totals.inputTokens,
    reserved: totals,
    reservedAttempts: selected.length,
    attemptReservations: selected,
    routeConstraints: { ...prepared.routeConstraints, maxAttempts: selected.length }
  };
}
