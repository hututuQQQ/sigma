import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  BudgetLedgerState,
  BudgetLimits,
  BudgetReservation
} from "agent-protocol";
import { emptyBudgetAmounts } from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import {
  mutationBudgetOwner,
  mutationReservationHasDelta,
  parseMutationBudgetOwner
} from "./mutation-budget.js";

const DIMENSIONS = [
  "inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"
] as const satisfies readonly (keyof BudgetAmounts)[];

export class BudgetExceededError extends Error {
  readonly code = "budget_exhausted";

  constructor(
    readonly dimension: keyof BudgetLimits,
    readonly requested: number,
    readonly available: number
  ) {
    super(`Budget '${dimension}' requires ${requested}, but only ${available} remains.`);
    this.name = "BudgetExceededError";
  }
}

function amounts(input: Partial<BudgetAmounts>): BudgetAmounts {
  const result = emptyBudgetAmounts();
  for (const dimension of DIMENSIONS) {
    const value = input[dimension] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Budget amount '${dimension}' must be a non-negative integer.`);
    result[dimension] = value;
  }
  return result;
}

function add(left: BudgetAmounts, right: BudgetAmounts): BudgetAmounts {
  return Object.fromEntries(DIMENSIONS.map((key) => [key, left[key] + right[key]])) as unknown as BudgetAmounts;
}

function subtract(left: BudgetAmounts, right: BudgetAmounts): BudgetAmounts {
  return Object.fromEntries(DIMENSIONS.map((key) => [key, left[key] - right[key]])) as unknown as BudgetAmounts;
}

const LIMIT_DIMENSIONS = [...DIMENSIONS, "maxDepth"] as const satisfies readonly (keyof BudgetLimits)[];

function increasedLimits(current: BudgetLimits, input: Partial<BudgetLimits>): {
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
  if (!entries.some(([, value]) => value.increment > 0)) throw new Error("At least one budget limit increase must be positive.");
  return {
    limits: Object.fromEntries(entries.map(([key, value]) => [key, value.next])) as unknown as BudgetLimits,
    increase: Object.fromEntries(entries.map(([key, value]) => [key, value.increment])) as unknown as BudgetLimits
  };
}

function settle(
  ledger: BudgetLedgerState,
  reservation: BudgetReservation,
  status: "committed" | "released",
  consumed: BudgetAmounts
): BudgetLedgerState {
  const now = new Date().toISOString();
  return {
    ...ledger,
    reserved: subtract(ledger.reserved, reservation.requested),
    consumed: status === "committed" ? add(ledger.consumed, consumed) : { ...ledger.consumed },
    reservations: ledger.reservations.map((item) => item.reservationId === reservation.reservationId
      ? { ...item, status, consumed, settledAt: now }
      : item)
  };
}

export class BudgetController {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly emit: RuntimeEventEmitter) {}

  async reserve(session: RuntimeSession, ownerId: string, requestedInput: Partial<BudgetAmounts>): Promise<string> {
    return await this.serial(session.sessionId, async () =>
      await this.reserveLocked(session, ownerId, requestedInput, 0));
  }

  async reserveChild<T>(
    session: RuntimeSession,
    ownerId: string,
    prepare: () => { requested: Partial<BudgetAmounts>; result: T }
  ): Promise<T> {
    return await this.serial(session.sessionId, async () => {
      await this.assertDepthLocked(session, 1);
      const child = prepare();
      await this.reserveLocked(session, ownerId, child.requested, 0);
      return child.result;
    });
  }

  async commit(session: RuntimeSession, reservationId: string, actualInput: Partial<BudgetAmounts>): Promise<void> {
    await this.serial(session.sessionId, async () => {
      const ledger = session.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved") throw new Error(`Unknown active budget reservation '${reservationId}'.`);
      const actual = amounts(actualInput);
      for (const dimension of DIMENSIONS) {
        if (actual[dimension] > reservation.requested[dimension]) {
          throw new BudgetExceededError(dimension, actual[dimension], reservation.requested[dimension]);
        }
      }
      const next = settle(ledger, reservation, "committed", actual);
      await this.emit(session, "budget.committed", "runtime", { reservationId, ledger: next });
    });
  }

  async commitIfReserved(
    session: RuntimeSession,
    reservationId: string,
    actualInput: Partial<BudgetAmounts>
  ): Promise<boolean> {
    return await this.serial(session.sessionId, async () => {
      const ledger = session.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved") return false;
      const actual = amounts(actualInput);
      for (const dimension of DIMENSIONS) {
        if (actual[dimension] > reservation.requested[dimension]) {
          throw new BudgetExceededError(dimension, actual[dimension], reservation.requested[dimension]);
        }
      }
      const next = settle(ledger, reservation, "committed", actual);
      await this.emit(session, "budget.committed", "runtime", { reservationId, ledger: next });
      return true;
    });
  }

  async bindToolCheckpoint(
    session: RuntimeSession,
    reservationId: string,
    callId: string,
    checkpointId: string
  ): Promise<void> {
    await this.serial(session.sessionId, async () => {
      const ledger = session.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved" || reservation.ownerId !== `tool:${callId}`) {
        throw new Error(`Unknown active tool budget reservation '${reservationId}'.`);
      }
      const ownerId = mutationBudgetOwner(callId, checkpointId);
      const next: BudgetLedgerState = {
        ...ledger,
        reservations: ledger.reservations.map((item) => item.reservationId === reservationId
          ? { ...item, ownerId } : item)
      };
      await this.emit(session, "budget.reservation_bound", "runtime", { reservationId, ownerId, ledger: next });
    });
  }

  async release(session: RuntimeSession, reservationId: string): Promise<void> {
    await this.serial(session.sessionId, async () => {
      const ledger = session.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved") return;
      const next = settle(ledger, reservation, "released", emptyBudgetAmounts());
      await this.emit(session, "budget.released", "runtime", { reservationId, ledger: next });
    });
  }

  async settleInterruptedTool(
    session: RuntimeSession,
    callId: string,
    disposition: "commit" | "release",
    checkpointId?: string
  ): Promise<void> {
    let reservation = session.state.budget.reservations.find((item) => {
      const mutation = parseMutationBudgetOwner(item.ownerId);
      return item.status === "reserved" && (item.ownerId === `tool:${callId}` || mutation?.callId === callId);
    });
    if (!reservation) return;
    if (disposition === "release") {
      await this.release(session, reservation.reservationId);
      return;
    }
    if (reservation.ownerId === `tool:${callId}` && checkpointId) {
      await this.bindToolCheckpoint(
        session, reservation.reservationId, callId, checkpointId
      );
      reservation = session.state.budget.reservations.find((item) =>
        item.reservationId === reservation!.reservationId) ?? reservation;
    }
    const mutation = parseMutationBudgetOwner(reservation.ownerId);
    if (mutation && mutationReservationHasDelta(session, mutation)) return;
    await this.commit(session, reservation.reservationId, {
      toolCalls: Math.min(1, reservation.requested.toolCalls)
    });
  }

  /**
   * Conservatively settles a provider attempt whose result was lost with the
   * process. A reserved attempt is charged at its complete reservation because
   * recovery cannot prove how far the provider progressed. Already committed
   * attempts are returned unchanged so the caller can backfill missing usage
   * without charging the reservation twice.
   */
  async settleInterruptedModel(session: RuntimeSession, requestId: string): Promise<BudgetAmounts | undefined> {
    const reservation = session.state.budget.reservations.find((item) =>
      item.ownerId === `model:${requestId}` && (item.status === "reserved" || item.status === "committed"));
    if (!reservation) return undefined;
    if (reservation.status === "reserved") {
      await this.commit(session, reservation.reservationId, reservation.requested);
      return { ...reservation.requested };
    }
    return { ...reservation.consumed };
  }

  async increaseLimits(session: RuntimeSession, requested: Partial<BudgetLimits>): Promise<BudgetLimits> {
    return await this.serial(session.sessionId, async () => {
      const previousLimits = { ...session.state.budget.limits };
      const { limits, increase } = increasedLimits(previousLimits, requested);
      const ledger: BudgetLedgerState = { ...session.state.budget, limits };
      await this.emit(session, "budget.limit_increased", "user", { previousLimits, increase, ledger });
      return { ...limits };
    });
  }

  private async reserveLocked(
    session: RuntimeSession,
    ownerId: string,
    requestedInput: Partial<BudgetAmounts>,
    requiredDepth: number
  ): Promise<string> {
    const requested = amounts(requestedInput);
    const ledger = session.state.budget;
    await this.assertDepthLocked(session, requiredDepth);
    for (const dimension of DIMENSIONS) {
      const used = ledger.consumed[dimension] + ledger.reserved[dimension];
      const available = ledger.limits[dimension] - used;
      if (requested[dimension] > available) {
        await this.emit(session, "budget.exhausted", "runtime", {
          dimension, requested: requested[dimension], available
        });
        throw new BudgetExceededError(dimension, requested[dimension], available);
      }
    }
    const reservationId = randomUUID();
    const reservation: BudgetReservation = {
      reservationId,
      ownerId,
      status: "reserved",
      requested,
      consumed: emptyBudgetAmounts(),
      createdAt: new Date().toISOString()
    };
    const next: BudgetLedgerState = {
      ...ledger,
      reserved: add(ledger.reserved, requested),
      reservations: [...ledger.reservations, reservation]
    };
    await this.emit(session, "budget.reserved", "runtime", { reservationId, ledger: next });
    return reservationId;
  }

  private async assertDepthLocked(session: RuntimeSession, requiredDepth: number): Promise<void> {
    const available = session.state.budget.limits.maxDepth;
    if (requiredDepth <= available) return;
    await this.emit(session, "budget.exhausted", "runtime", {
      dimension: "maxDepth", requested: requiredDepth, available
    });
    throw new BudgetExceededError("maxDepth", requiredDepth, available);
  }

  private async serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    const current = previous.then(async () => {
      try { resolve(await operation()); } catch (error) { reject(error); }
    });
    const queued = current.finally(() => {
      if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId);
    });
    this.queues.set(sessionId, queued);
    return await result;
  }
}
