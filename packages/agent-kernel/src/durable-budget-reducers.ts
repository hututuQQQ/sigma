import {
  createBudgetLedger,
  isBudgetLedgerState,
  isBudgetMutation,
  type AgentEventEnvelope,
  type AgentEventType,
  type BudgetAmounts,
  type BudgetLedgerState,
  type BudgetLimits,
  type BudgetMutation
} from "agent-protocol";
import type { KernelEventReducer } from "./durable-reducers.js";

const BUDGET_DIMENSIONS = [
  "inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"
] as const satisfies readonly (keyof BudgetAmounts)[];
const LIMIT_DIMENSIONS = [...BUDGET_DIMENSIONS, "maxDepth"] as const satisfies readonly (keyof BudgetLimits)[];

export class InvalidBudgetTransitionError extends Error {
  readonly code = "invalid_budget_transition";

  constructor(readonly eventType: AgentEventType, message: string) {
    super(`Invalid ${eventType} transition: ${message}`);
    this.name = "InvalidBudgetTransitionError";
  }
}

function sameBudgetAmounts(left: BudgetAmounts, right: BudgetAmounts): boolean {
  return BUDGET_DIMENSIONS.every((dimension) => left[dimension] === right[dimension]);
}

function sameBudgetLimits(left: BudgetLimits, right: BudgetLimits): boolean {
  return LIMIT_DIMENSIONS.every((dimension) => left[dimension] === right[dimension]);
}

function adjustedBudgetAmounts(
  left: BudgetAmounts,
  right: BudgetAmounts,
  operation: "add" | "subtract"
): BudgetAmounts | undefined {
  const entries = BUDGET_DIMENSIONS.map((dimension) => {
    const value = operation === "add" ? left[dimension] + right[dimension] : left[dimension] - right[dimension];
    return [dimension, value] as const;
  });
  if (entries.some(([, value]) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  return Object.fromEntries(entries) as unknown as BudgetAmounts;
}

function summedReservations(
  ledger: BudgetLedgerState,
  status: "reserved" | "committed",
  amounts: "requested" | "consumed"
): BudgetAmounts | undefined {
  let total = Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])) as unknown as BudgetAmounts;
  for (const reservation of ledger.reservations) {
    if (reservation.status !== status) continue;
    const next = adjustedBudgetAmounts(total, reservation[amounts], "add");
    if (!next) return undefined;
    total = next;
  }
  return total;
}

export function isBudgetLedgerSemanticallyValid(value: unknown): value is BudgetLedgerState {
  if (!isBudgetLedgerState(value)) return false;
  if (new Set(value.reservations.map((item) => item.reservationId)).size !== value.reservations.length) return false;
  for (const reservation of value.reservations) {
    if (reservation.status === "reserved" && (reservation.settledAt !== undefined
      || BUDGET_DIMENSIONS.some((dimension) => reservation.consumed[dimension] !== 0))) return false;
    if (reservation.status === "released" && (reservation.settledAt === undefined
      || BUDGET_DIMENSIONS.some((dimension) => reservation.consumed[dimension] !== 0))) return false;
    if (reservation.status === "committed" && reservation.settledAt === undefined) return false;
  }
  const reserved = summedReservations(value, "reserved", "requested");
  const consumed = summedReservations(value, "committed", "consumed");
  return Boolean(reserved && consumed
    && sameBudgetAmounts(value.reserved, reserved)
    && sameBudgetAmounts(value.consumed, consumed));
}

function pristineLedger(ledger: BudgetLedgerState): boolean {
  return ledger.reservations.length === 0
    && sameBudgetAmounts(ledger.reserved, Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, 0])) as unknown as BudgetAmounts)
    && sameBudgetAmounts(ledger.consumed, Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, 0])) as unknown as BudgetAmounts);
}

function applyReserve(
  ledger: BudgetLedgerState,
  mutation: Extract<BudgetMutation, { kind: "reserve" }>
): BudgetLedgerState | undefined {
  const reservation = mutation.reservation;
  if (reservation.status !== "reserved" || reservation.settledAt !== undefined
    || BUDGET_DIMENSIONS.some((dimension) => reservation.consumed[dimension] !== 0)
    || ledger.reservations.some((item) => item.reservationId === reservation.reservationId)) return undefined;
  if (BUDGET_DIMENSIONS.some((dimension) => {
    const used = ledger.consumed[dimension] + ledger.reserved[dimension];
    return reservation.requested[dimension] > Math.max(0, ledger.limits[dimension] - used);
  })) return undefined;
  const reserved = adjustedBudgetAmounts(ledger.reserved, reservation.requested, "add");
  if (!reserved || !sameBudgetAmounts(reserved, mutation.totals.reserved)
    || !sameBudgetAmounts(ledger.consumed, mutation.totals.consumed)) return undefined;
  return { ...ledger, reserved, reservations: [...ledger.reservations, reservation] };
}

function applySettle(
  ledger: BudgetLedgerState,
  mutation: Extract<BudgetMutation, { kind: "settle" }>
): BudgetLedgerState | undefined {
  const reservation = ledger.reservations.find((item) => item.reservationId === mutation.reservationId);
  if (!reservation || reservation.status !== "reserved"
    || (mutation.status === "released"
      && BUDGET_DIMENSIONS.some((dimension) => mutation.consumed[dimension] !== 0))) return undefined;
  const reserved = adjustedBudgetAmounts(ledger.reserved, reservation.requested, "subtract");
  const consumed = mutation.status === "committed"
    ? adjustedBudgetAmounts(ledger.consumed, mutation.consumed, "add")
    : { ...ledger.consumed };
  if (!reserved || !consumed || !sameBudgetAmounts(reserved, mutation.totals.reserved)
    || !sameBudgetAmounts(consumed, mutation.totals.consumed)) return undefined;
  return {
    ...ledger,
    reserved,
    consumed,
    reservations: ledger.reservations.map((item) => item.reservationId === mutation.reservationId
      ? { ...item, status: mutation.status, consumed: mutation.consumed, settledAt: mutation.settledAt }
      : item)
  };
}

function applyBind(
  ledger: BudgetLedgerState,
  mutation: Extract<BudgetMutation, { kind: "bind" }>
): BudgetLedgerState | undefined {
  const reservation = ledger.reservations.find((item) => item.reservationId === mutation.reservationId);
  if (!reservation || reservation.status !== "reserved") return undefined;
  return {
    ...ledger,
    reservations: ledger.reservations.map((item) => item.reservationId === mutation.reservationId
      ? { ...item, ownerId: mutation.ownerId }
      : item)
  };
}

function applyLimit(
  ledger: BudgetLedgerState,
  mutation: Extract<BudgetMutation, { kind: "limit" }>
): BudgetLedgerState | undefined {
  if (!LIMIT_DIMENSIONS.some((dimension) => mutation.increase[dimension] > 0)
    || LIMIT_DIMENSIONS.some((dimension) =>
      ledger.limits[dimension] + mutation.increase[dimension] !== mutation.limits[dimension])) return undefined;
  return { ...ledger, limits: mutation.limits };
}

export function applyBudgetMutation(
  ledger: BudgetLedgerState,
  mutation: BudgetMutation
): BudgetLedgerState | undefined {
  switch (mutation.kind) {
    case "reserve": return applyReserve(ledger, mutation);
    case "settle": return applySettle(ledger, mutation);
    case "bind": return applyBind(ledger, mutation);
    case "limit": return applyLimit(ledger, mutation);
  }
}

const MUTATION_KIND_BY_EVENT = {
  "budget.reserved": "reserve",
  "budget.reservation_bound": "bind",
  "budget.committed": "settle",
  "budget.released": "settle",
  "budget.limit_increased": "limit"
} as const;

function eventPayload(event: AgentEventEnvelope): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
}

function initialLedger(value: unknown): BudgetLedgerState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = createBudgetLedger(value as BudgetLimits);
  return isBudgetLedgerState(candidate) ? candidate : undefined;
}

function mutationMatchesEvent(event: AgentEventEnvelope, mutation: BudgetMutation): boolean {
  const expectedKind = MUTATION_KIND_BY_EVENT[event.type as keyof typeof MUTATION_KIND_BY_EVENT];
  if (!expectedKind || mutation.kind !== expectedKind) return false;
  if (event.type === "budget.committed") return mutation.kind === "settle" && mutation.status === "committed";
  if (event.type === "budget.released") return mutation.kind === "settle" && mutation.status === "released";
  return true;
}

function replayBudgetMutationEvent(
  ledger: BudgetLedgerState | undefined,
  event: AgentEventEnvelope,
  payload: Record<string, unknown>
): BudgetLedgerState | undefined {
  if (!(event.type in MUTATION_KIND_BY_EVENT)) return ledger;
  const expectedAuthority = event.type === "budget.limit_increased" ? "user" : "runtime";
  if (event.authority !== expectedAuthority) {
    throw new InvalidBudgetTransitionError(event.type, `authority must be '${expectedAuthority}'`);
  }
  if (!ledger || !isBudgetLedgerSemanticallyValid(ledger)) {
    throw new InvalidBudgetTransitionError(event.type, "the prior ledger is missing or semantically invalid");
  }
  if (!isBudgetMutation(payload.mutation) || !mutationMatchesEvent(event, payload.mutation)) {
    throw new InvalidBudgetTransitionError(event.type, "compact mutation does not match the event type");
  }
  const next = applyBudgetMutation(ledger, payload.mutation);
  if (!next || !isBudgetLedgerSemanticallyValid(next)) {
    throw new InvalidBudgetTransitionError(event.type, "compact mutation totals or reservation state are invalid");
  }
  return next;
}

/**
 * Replays one durable budget authority event. Kernel reduction and
 * out-of-process child recovery share this path so their accounting cannot drift.
 */
export function replayBudgetLedgerEvent(
  ledger: BudgetLedgerState | undefined,
  event: AgentEventEnvelope
): BudgetLedgerState | undefined {
  const payload = eventPayload(event);
  if (event.type === "session.created") {
    if (event.authority !== "runtime") {
      throw new InvalidBudgetTransitionError(event.type, "session creation requires runtime authority");
    }
    if (ledger) {
      if (!isBudgetLedgerSemanticallyValid(ledger) || !pristineLedger(ledger)) {
        throw new InvalidBudgetTransitionError(event.type, "session creation cannot reset an established ledger");
      }
      const declared = initialLedger(payload.budgetLimits);
      if (!declared || !sameBudgetLimits(declared.limits, ledger.limits)) {
        throw new InvalidBudgetTransitionError(event.type, "declared limits do not match the initialized ledger");
      }
      return ledger;
    }
    const initial = initialLedger(payload.budgetLimits);
    if (!initial) throw new InvalidBudgetTransitionError(event.type, "initial budget limits are invalid");
    return initial;
  }
  return replayBudgetMutationEvent(ledger, event, payload);
}

const budgetUpdated: KernelEventReducer = (state, event) => {
  const budget = replayBudgetLedgerEvent(state.budget, event);
  return budget && budget !== state.budget ? { ...state, budget } : state;
};

export const durableBudgetReducers: Partial<Record<AgentEventType, KernelEventReducer>> = {
  "session.created": budgetUpdated,
  "budget.reserved": budgetUpdated,
  "budget.reservation_bound": budgetUpdated,
  "budget.committed": budgetUpdated,
  "budget.released": budgetUpdated,
  "budget.limit_increased": budgetUpdated
};
