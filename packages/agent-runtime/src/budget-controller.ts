import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  BudgetLedgerState,
  BudgetLimits,
  BudgetReservation
} from "agent-protocol";
import { emptyBudgetAmounts, isBudgetLedgerState } from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import {
  mutationBudgetOwner,
  mutationReservationHasDelta,
  parseMutationBudgetOwner
} from "./mutation-budget.js";
import {
  BUDGET_DIMENSIONS,
  addBudgetAmounts,
  budgetAmounts,
  budgetTotals,
  increasedBudgetLimits,
  settleBudgetReservation,
  settledBudgetMutation
} from "./budget-ledger-operations.js";

export interface MeasuredBudgetOverrun {
  dimension: keyof BudgetAmounts;
  reserved: number;
  actual: number;
  overReservation: number;
  limit: number;
  consumed: number;
  overLimit: number;
}
export interface MeasuredBudgetSettlement {
  overReservation: Partial<BudgetAmounts>;
  overLimit: Partial<BudgetAmounts>;
  overruns: readonly MeasuredBudgetOverrun[];
}

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

export class BudgetController {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly emit: RuntimeEventEmitter) {}

  async reserve(session: RuntimeSession, ownerId: string, requestedInput: Partial<BudgetAmounts>): Promise<string> {
    return await this.serial(session.identity.sessionId, async () =>
      await this.reserveLocked(session, ownerId, requestedInput, 0));
  }

  async reserveChild<T>(
    session: RuntimeSession,
    ownerId: string,
    prepare: () => { requested: Partial<BudgetAmounts>; result: T }
  ): Promise<T> {
    return await this.serial(session.identity.sessionId, async () => {
      await this.assertDepthLocked(session, 1);
      const child = prepare();
      await this.reserveLocked(session, ownerId, child.requested, 0);
      return child.result;
    });
  }

  async commit(session: RuntimeSession, reservationId: string, actualInput: Partial<BudgetAmounts>): Promise<void> {
    await this.serial(session.identity.sessionId, async () => {
      const ledger = session.durable.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved") throw new Error(`Unknown active budget reservation '${reservationId}'.`);
      const actual = budgetAmounts(actualInput);
      for (const dimension of BUDGET_DIMENSIONS) {
        if (actual[dimension] > reservation.requested[dimension]) {
          throw new BudgetExceededError(dimension, actual[dimension], reservation.requested[dimension]);
        }
      }
      const next = settleBudgetReservation(ledger, reservation, "committed", actual);
      await this.emitAndApply(session, ledger, next, async () => await this.emit(
        session, "budget.committed", "runtime",
        { reservationId, mutation: settledBudgetMutation(next, reservationId, "committed", actual) }
      ));
    });
  }

  async commitMeasured(
    session: RuntimeSession,
    reservationId: string,
    actualInput: Partial<BudgetAmounts>
  ): Promise<MeasuredBudgetSettlement> {
    return await this.serial(session.identity.sessionId, async () => {
      const ledger = session.durable.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status === "released") {
        throw new Error(`Unknown unsettled budget reservation '${reservationId}'.`);
      }
      const actual = budgetAmounts(actualInput);
      if (reservation.status === "committed" && BUDGET_DIMENSIONS.some((dimension) =>
        reservation.consumed[dimension] !== actual[dimension])) {
        throw new Error(`Committed budget reservation '${reservationId}' does not match the measured usage.`);
      }
      const next = reservation.status === "reserved"
        ? settleBudgetReservation(ledger, reservation, "committed", actual)
        : ledger;
      const overruns = BUDGET_DIMENSIONS.flatMap((dimension): MeasuredBudgetOverrun[] => {
        const overReservation = Math.max(0, actual[dimension] - reservation.requested[dimension]);
        const overLimit = Math.max(0, next.consumed[dimension] + next.reserved[dimension] - next.limits[dimension]);
        return overReservation === 0 && overLimit === 0 ? [] : [{
          dimension,
          reserved: reservation.requested[dimension],
          actual: actual[dimension],
          overReservation,
          limit: next.limits[dimension],
          consumed: next.consumed[dimension],
          overLimit
        }];
      });
      const overLimitDimensions = overruns.filter((item) => item.overLimit > 0);
      if (reservation.status === "reserved") {
        await this.emitAndApply(session, ledger, next, async () => await this.emit(
          session, "budget.committed", "runtime",
          { reservationId, mutation: settledBudgetMutation(next, reservationId, "committed", actual) }
        ));
        if (overLimitDimensions.length > 0) {
          await this.emit(session, "budget.overrun", "runtime", {
            reservationId,
            dimensions: overLimitDimensions
          });
        }
      }
      return {
        overReservation: Object.fromEntries(overruns
          .filter((item) => item.overReservation > 0)
          .map((item) => [item.dimension, item.overReservation])) as Partial<BudgetAmounts>,
        overLimit: Object.fromEntries(overLimitDimensions
          .map((item) => [item.dimension, item.overLimit])) as Partial<BudgetAmounts>,
        overruns
      };
    });
  }

  async commitIfReserved(
    session: RuntimeSession,
    reservationId: string,
    actualInput: Partial<BudgetAmounts>
  ): Promise<boolean> {
    return await this.serial(session.identity.sessionId, async () => {
      const ledger = session.durable.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved") return false;
      const actual = budgetAmounts(actualInput);
      for (const dimension of BUDGET_DIMENSIONS) {
        if (actual[dimension] > reservation.requested[dimension]) {
          throw new BudgetExceededError(dimension, actual[dimension], reservation.requested[dimension]);
        }
      }
      const next = settleBudgetReservation(ledger, reservation, "committed", actual);
      await this.emitAndApply(session, ledger, next, async () => await this.emit(
        session, "budget.committed", "runtime",
        { reservationId, mutation: settledBudgetMutation(next, reservationId, "committed", actual) }
      ));
      return true;
    });
  }

  async bindToolCheckpoint(
    session: RuntimeSession,
    reservationId: string,
    callId: string,
    checkpointId: string
  ): Promise<void> {
    await this.serial(session.identity.sessionId, async () => {
      const ledger = session.durable.state.budget;
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
      await this.emitAndApply(session, ledger, next, async () => await this.emit(
        session, "budget.reservation_bound", "runtime", {
          reservationId,
          ownerId,
          mutation: { schemaVersion: 1, kind: "bind", reservationId, ownerId }
        }
      ));
    });
  }

  async release(session: RuntimeSession, reservationId: string): Promise<void> {
    await this.serial(session.identity.sessionId, async () => {
      const ledger = session.durable.state.budget;
      const reservation = ledger.reservations.find((item) => item.reservationId === reservationId);
      if (!reservation || reservation.status !== "reserved") return;
      const next = settleBudgetReservation(ledger, reservation, "released", emptyBudgetAmounts());
      await this.emitAndApply(session, ledger, next, async () => await this.emit(
        session, "budget.released", "runtime", {
          reservationId,
          mutation: settledBudgetMutation(next, reservationId, "released", emptyBudgetAmounts())
        }
      ));
    });
  }

  async settleInterruptedTool(
    session: RuntimeSession,
    callId: string,
    disposition: "commit" | "release",
    checkpointId?: string
  ): Promise<void> {
    let reservation = session.durable.state.budget.reservations.find((item) => {
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
      reservation = session.durable.state.budget.reservations.find((item) =>
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
    const reservation = session.durable.state.budget.reservations.find((item) =>
      item.ownerId === `model:${requestId}` && (item.status === "reserved" || item.status === "committed"));
    if (!reservation) return undefined;
    if (reservation.status === "reserved") {
      await this.commit(session, reservation.reservationId, reservation.requested);
      return { ...reservation.requested };
    }
    return { ...reservation.consumed };
  }

  async increaseLimits(session: RuntimeSession, requested: Partial<BudgetLimits>): Promise<BudgetLimits> {
    return await this.serial(session.identity.sessionId, async () => {
      const previousLimits = { ...session.durable.state.budget.limits };
      const { limits, increase } = increasedBudgetLimits(previousLimits, requested);
      const ledger: BudgetLedgerState = { ...session.durable.state.budget, limits };
      const before = session.durable.state.budget;
      await this.emitAndApply(session, before, ledger, async () => await this.emit(
        session, "budget.limit_increased", "user",
        { mutation: { schemaVersion: 1, kind: "limit", increase, limits } }
      ));
      return { ...limits };
    });
  }

  private async reserveLocked(
    session: RuntimeSession,
    ownerId: string,
    requestedInput: Partial<BudgetAmounts>,
    requiredDepth: number
  ): Promise<string> {
    const requested = budgetAmounts(requestedInput);
    const ledger = session.durable.state.budget;
    await this.assertDepthLocked(session, requiredDepth);
    for (const dimension of BUDGET_DIMENSIONS) {
      const used = ledger.consumed[dimension] + ledger.reserved[dimension];
      const available = Math.max(0, ledger.limits[dimension] - used);
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
      reserved: addBudgetAmounts(ledger.reserved, requested),
      reservations: [...ledger.reservations, reservation]
    };
    await this.emitAndApply(session, ledger, next, async () => await this.emit(
      session, "budget.reserved", "runtime", {
        reservationId,
        mutation: {
          schemaVersion: 1,
          kind: "reserve",
          reservation,
          totals: budgetTotals(next)
        }
      }
    ));
    return reservationId;
  }

  private async emitAndApply(
    session: RuntimeSession,
    previous: BudgetLedgerState,
    next: BudgetLedgerState,
    emit: () => Promise<unknown>
  ): Promise<void> {
    await emit();
    // RuntimeEventLog reduces the durable event synchronously. Lightweight
    // embedders may provide a persistence-only emitter, so keep the controller
    // usable without writing a second event or a full ledger payload.
    if (session.durable.state.budget === previous || !isBudgetLedgerState(session.durable.state.budget)) {
      session.durable.state.budget = next;
    }
  }

  private async assertDepthLocked(session: RuntimeSession, requiredDepth: number): Promise<void> {
    const available = session.durable.state.budget.limits.maxDepth;
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
