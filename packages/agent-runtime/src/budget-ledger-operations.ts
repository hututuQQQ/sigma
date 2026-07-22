import type {
  BudgetAmounts,
  BudgetLedgerState,
  BudgetLimits,
  BudgetMutationV1,
  BudgetReservation
} from "agent-protocol";
import { emptyBudgetAmounts } from "agent-protocol";

export const BUDGET_DIMENSIONS = [
  "inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"
] as const satisfies readonly (keyof BudgetAmounts)[];

export function budgetAmounts(input: Partial<BudgetAmounts>): BudgetAmounts {
  const result = emptyBudgetAmounts();
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = input[dimension] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Budget amount '${dimension}' must be a non-negative integer.`);
    }
    result[dimension] = value;
  }
  return result;
}
export function addBudgetAmounts(left: BudgetAmounts, right: BudgetAmounts): BudgetAmounts {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, left[key] + right[key]])) as unknown as BudgetAmounts;
}

function subtract(left: BudgetAmounts, right: BudgetAmounts): BudgetAmounts {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, left[key] - right[key]])) as unknown as BudgetAmounts;
}

const LIMIT_DIMENSIONS = [...BUDGET_DIMENSIONS, "maxDepth"] as const satisfies readonly (keyof BudgetLimits)[];

export function increasedBudgetLimits(current: BudgetLimits, input: Partial<BudgetLimits>): {
  limits: BudgetLimits;
  increase: BudgetLimits;
} {
  const entries = LIMIT_DIMENSIONS.map((dimension) => {
    const increment = input[dimension] ?? 0;
    if (!Number.isSafeInteger(increment) || increment < 0) {
      throw new Error(`Budget increase '${dimension}' must be a non-negative integer.`);
    }
    const next = current[dimension] + increment;
    if (!Number.isSafeInteger(next)) throw new Error(`Budget limit '${dimension}' exceeds the safe integer range.`);
    return [dimension, { increment, next }] as const;
  });
  if (!entries.some(([, value]) => value.increment > 0)) {
    throw new Error("At least one budget limit increase must be positive.");
  }
  return {
    limits: Object.fromEntries(entries.map(([key, value]) => [key, value.next])) as unknown as BudgetLimits,
    increase: Object.fromEntries(entries.map(([key, value]) => [key, value.increment])) as unknown as BudgetLimits
  };
}

export function settleBudgetReservation(
  ledger: BudgetLedgerState,
  reservation: BudgetReservation,
  status: "committed" | "released",
  consumed: BudgetAmounts
): BudgetLedgerState {
  const now = new Date().toISOString();
  return {
    ...ledger,
    reserved: subtract(ledger.reserved, reservation.requested),
    consumed: status === "committed" ? addBudgetAmounts(ledger.consumed, consumed) : { ...ledger.consumed },
    reservations: ledger.reservations.map((item) => item.reservationId === reservation.reservationId
      ? { ...item, status, consumed, settledAt: now }
      : item)
  };
}

export function budgetTotals(ledger: BudgetLedgerState): {
  consumed: BudgetAmounts;
  reserved: BudgetAmounts;
} {
  return { consumed: { ...ledger.consumed }, reserved: { ...ledger.reserved } };
}

export function settledBudgetMutation(
  ledger: BudgetLedgerState,
  reservationId: string,
  status: "committed" | "released",
  consumed: BudgetAmounts
): Extract<BudgetMutationV1, { kind: "settle" }> {
  const settledAt = ledger.reservations.find((item) => item.reservationId === reservationId)?.settledAt;
  if (!settledAt) throw new Error(`Settled budget reservation '${reservationId}' has no settlement timestamp.`);
  return {
    schemaVersion: 1,
    kind: "settle",
    reservationId,
    status,
    consumed,
    settledAt,
    totals: budgetTotals(ledger)
  };
}
