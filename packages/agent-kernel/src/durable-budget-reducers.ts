import {
  createBudgetLedger,
  isBudgetLedgerState,
  isBudgetMutationV1,
  type AgentEventEnvelope,
  type AgentEventType,
  type BudgetAmounts,
  type BudgetLedgerState,
  type BudgetLimits,
  type BudgetMutationV1
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

function sameReservation(
  left: BudgetLedgerState["reservations"][number],
  right: BudgetLedgerState["reservations"][number]
): boolean {
  return left.reservationId === right.reservationId
    && left.ownerId === right.ownerId
    && left.status === right.status
    && sameBudgetAmounts(left.requested, right.requested)
    && sameBudgetAmounts(left.consumed, right.consumed)
    && left.createdAt === right.createdAt
    && left.settledAt === right.settledAt;
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

/** Stronger than the wire shape: validates retained reservation history and ledger totals. */
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
  mutation: Extract<BudgetMutationV1, { kind: "reserve" }>
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
  mutation: Extract<BudgetMutationV1, { kind: "settle" }>
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
  mutation: Extract<BudgetMutationV1, { kind: "bind" }>
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
  mutation: Extract<BudgetMutationV1, { kind: "limit" }>
): BudgetLedgerState | undefined {
  if (!LIMIT_DIMENSIONS.some((dimension) => mutation.increase[dimension] > 0)
    || LIMIT_DIMENSIONS.some((dimension) =>
      ledger.limits[dimension] + mutation.increase[dimension] !== mutation.limits[dimension])) return undefined;
  return { ...ledger, limits: mutation.limits };
}

/** Applies a compact event-log mutation while checking its post totals. */
export function applyBudgetMutationV1(
  ledger: BudgetLedgerState,
  mutation: BudgetMutationV1
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

function unchangedReservations(
  before: BudgetLedgerState,
  after: BudgetLedgerState,
  changedIndex: number,
  changed: (beforeItem: BudgetLedgerState["reservations"][number], afterItem: BudgetLedgerState["reservations"][number]) => boolean
): boolean {
  return before.reservations.length === after.reservations.length
    && before.reservations.every((item, index) => index === changedIndex
      ? changed(item, after.reservations[index]!)
      : sameReservation(item, after.reservations[index]!));
}

function legacyReserveTransition(
  ledger: BudgetLedgerState,
  candidate: BudgetLedgerState,
  reservationId: unknown
): boolean {
  if (typeof reservationId !== "string" || candidate.reservations.length !== ledger.reservations.length + 1
    || !ledger.reservations.every((item, index) => sameReservation(item, candidate.reservations[index]!))) return false;
  const reservation = candidate.reservations.at(-1)!;
  const reserved = adjustedBudgetAmounts(ledger.reserved, reservation.requested, "add");
  const limitsCompatible = sameBudgetLimits(ledger.limits, candidate.limits) || pristineLedger(ledger);
  return reservation.reservationId === reservationId && reservation.status === "reserved"
    && Boolean(reserved) && limitsCompatible
    && sameBudgetAmounts(candidate.reserved, reserved!)
    && sameBudgetAmounts(candidate.consumed, ledger.consumed);
}

function legacySettleTransition(
  ledger: BudgetLedgerState,
  candidate: BudgetLedgerState,
  reservationId: unknown,
  status: "committed" | "released"
): boolean {
  if (typeof reservationId !== "string" || !sameBudgetLimits(ledger.limits, candidate.limits)) return false;
  const index = ledger.reservations.findIndex((item) => item.reservationId === reservationId);
  if (index < 0 || ledger.reservations[index]!.status !== "reserved") return false;
  const before = ledger.reservations[index]!;
  const after = candidate.reservations[index];
  if (!after || !settledReservationMatches(before, after, status)) return false;
  const reserved = adjustedBudgetAmounts(ledger.reserved, before.requested, "subtract");
  const consumed = status === "committed"
    ? adjustedBudgetAmounts(ledger.consumed, after.consumed, "add") : ledger.consumed;
  return unchangedReservations(ledger, candidate, index, (_prior, next) => sameReservation(after, next))
    && Boolean(reserved && consumed)
    && sameBudgetAmounts(candidate.reserved, reserved!)
    && sameBudgetAmounts(candidate.consumed, consumed!);
}

function settledReservationMatches(
  before: BudgetLedgerState["reservations"][number],
  after: BudgetLedgerState["reservations"][number],
  status: "committed" | "released"
): boolean {
  if (after.status !== status || after.reservationId !== before.reservationId || after.ownerId !== before.ownerId) {
    return false;
  }
  if (!sameBudgetAmounts(after.requested, before.requested)
    || after.createdAt !== before.createdAt || after.settledAt === undefined) return false;
  return status !== "released"
    || BUDGET_DIMENSIONS.every((dimension) => after.consumed[dimension] === 0);
}

function legacyBindTransition(
  ledger: BudgetLedgerState,
  candidate: BudgetLedgerState,
  reservationId: unknown,
  ownerId: unknown
): boolean {
  if (typeof reservationId !== "string" || typeof ownerId !== "string"
    || !sameBudgetLimits(ledger.limits, candidate.limits)
    || !sameBudgetAmounts(ledger.reserved, candidate.reserved)
    || !sameBudgetAmounts(ledger.consumed, candidate.consumed)) return false;
  const index = ledger.reservations.findIndex((item) => item.reservationId === reservationId);
  if (index < 0 || ledger.reservations[index]!.status !== "reserved") return false;
  return unchangedReservations(ledger, candidate, index, (before, after) =>
    after.ownerId === ownerId && sameReservation({ ...before, ownerId }, after));
}

function legacyLimitTransition(
  ledger: BudgetLedgerState,
  candidate: BudgetLedgerState,
  payload: Record<string, unknown>
): boolean {
  const previous = initialLedger(payload.previousLimits)?.limits;
  const increase = payload.increase && typeof payload.increase === "object" && !Array.isArray(payload.increase)
    ? payload.increase as Record<string, unknown> : undefined;
  if (!previous || !increase || !sameBudgetLimits(previous, ledger.limits)
    || !sameBudgetAmounts(ledger.reserved, candidate.reserved)
    || !sameBudgetAmounts(ledger.consumed, candidate.consumed)
    || ledger.reservations.length !== candidate.reservations.length
    || !ledger.reservations.every((item, index) => sameReservation(item, candidate.reservations[index]!))) return false;
  let positive = false;
  return LIMIT_DIMENSIONS.every((dimension) => {
    const amount = increase[dimension] ?? 0;
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) return false;
    if (Number(amount) > 0) positive = true;
    return ledger.limits[dimension] + Number(amount) === candidate.limits[dimension];
  }) && positive;
}

function validLegacyTransition(
  ledger: BudgetLedgerState,
  event: AgentEventEnvelope,
  payload: Record<string, unknown>,
  candidate: BudgetLedgerState
): boolean {
  if (!isBudgetLedgerSemanticallyValid(candidate)) return false;
  switch (event.type) {
    case "budget.reserved": return legacyReserveTransition(ledger, candidate, payload.reservationId);
    case "budget.committed": return legacySettleTransition(ledger, candidate, payload.reservationId, "committed");
    case "budget.released": return legacySettleTransition(ledger, candidate, payload.reservationId, "released");
    case "budget.reservation_bound": return legacyBindTransition(
      ledger, candidate, payload.reservationId, payload.ownerId
    );
    case "budget.limit_increased": return legacyLimitTransition(ledger, candidate, payload);
    default: return false;
  }
}

function mutationMatchesEvent(event: AgentEventEnvelope, mutation: BudgetMutationV1): boolean {
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
  if (isBudgetLedgerState(payload.ledger)) {
    if (!validLegacyTransition(ledger, event, payload, payload.ledger)) {
      throw new InvalidBudgetTransitionError(event.type, "legacy full-ledger state does not match the declared transition");
    }
    return payload.ledger;
  }
  if (!isBudgetMutationV1(payload.mutation) || !mutationMatchesEvent(event, payload.mutation)) {
    throw new InvalidBudgetTransitionError(event.type, "compact mutation does not match the event type");
  }
  const next = applyBudgetMutationV1(ledger, payload.mutation);
  if (!next || !isBudgetLedgerSemanticallyValid(next)) {
    throw new InvalidBudgetTransitionError(event.type, "compact mutation totals or reservation state are invalid");
  }
  return next;
}

/**
 * Replays one durable budget authority event. The optional input lets recovery
 * establish the zero-usage ledger from a legacy session.created event before
 * applying either legacy full-ledger records or compact BudgetMutationV1
 * records. Kernel reduction and out-of-process child recovery share this path
 * so their accounting cannot drift.
 */
export function replayBudgetLedgerEvent(
  ledger: BudgetLedgerState | undefined,
  event: AgentEventEnvelope
): BudgetLedgerState | undefined {
  const payload = eventPayload(event);
  if (event.type === "session.created") {
    if (event.authority !== "runtime" || event.seq !== 1) {
      throw new InvalidBudgetTransitionError(event.type, "session creation must be the first runtime event");
    }
    if (ledger && (!isBudgetLedgerSemanticallyValid(ledger) || !pristineLedger(ledger))) {
      throw new InvalidBudgetTransitionError(event.type, "session creation cannot reset an established ledger");
    }
    const initial = payload.budgetLimits === undefined ? createBudgetLedger() : initialLedger(payload.budgetLimits);
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
