import { describe, expect, it } from "vitest";
import {
  applyBudgetMutationV1,
  createKernelState,
  isBudgetLedgerSemanticallyValid,
  rehydrate,
  replayBudgetLedgerEvent
} from "../packages/agent-kernel/src/index.js";
import {
  createBudgetLedger,
  emptyBudgetAmounts,
  EVENT_SCHEMA_VERSION,
  isAgentEventEnvelope,
  type AgentEventEnvelope,
  type BudgetAmounts,
  type BudgetLedgerState,
  type BudgetReservation,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function amounts(inputTokens = 0): BudgetAmounts {
  return { ...emptyBudgetAmounts(), inputTokens };
}

function reservation(id: string, requested: number, createdAt: string): BudgetReservation {
  return {
    reservationId: id,
    ownerId: `owner:${id}`,
    status: "reserved",
    requested: amounts(requested),
    consumed: amounts(),
    createdAt
  };
}

function envelope(
  seq: number,
  type: AgentEventEnvelope["type"],
  payload: JsonValue,
  authority: AgentEventEnvelope["authority"] = "runtime"
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: `event-${seq}`,
    sessionId: "budget-session",
    runId: "budget-run",
    occurredAt: new Date(seq * 1_000).toISOString(),
    type,
    authority,
    payload
  };
}

describe("compact budget mutation persistence", () => {
  it("keeps 1,000 reservation lifecycles linear and omits full ledgers from new events", async () => {
    const target = runtimeSessionFixture({ sessionId: "budget-session", runId: "budget-run" });
    target.durable.state.budget = createBudgetLedger({
      inputTokens: 10_000,
      outputTokens: 10_000,
      costMicroUsd: 10_000,
      modelTurns: 10_000,
      toolCalls: 10_000,
      children: 10_000,
      maxDepth: 4
    });
    const payloads: JsonValue[] = [];
    const budgets = new BudgetController(async (_session, _type, _authority, payload) => {
      payloads.push(payload as JsonValue);
      return {} as AgentEventEnvelope;
    });

    for (let index = 0; index < 1_000; index += 1) {
      const id = await budgets.reserve(target, `load:${index}`, { inputTokens: 1 });
      await budgets.release(target, id);
    }

    const sizes = payloads.map((payload) => JSON.stringify(payload).length);
    expect(payloads).toHaveLength(2_000);
    expect(payloads.every((payload) => !Object.hasOwn(payload as object, "ledger"))).toBe(true);
    expect(Math.max(...sizes)).toBeLessThan(1_024);
    expect(sizes.at(-1)! - sizes[0]!).toBeLessThan(32);
    expect(target.durable.state.budget.reservations).toHaveLength(1_000);
    expect(target.durable.state.budget.reserved.inputTokens).toBe(0);
  });

  it("replays legacy full-ledger and compact mutation events in one session", () => {
    const initial = createKernelState({
      sessionId: "budget-session",
      runId: "budget-run",
      mode: "change",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60_000).toISOString()
    });
    const first = reservation("first", 10, new Date(1_000).toISOString());
    const legacyReserved: BudgetLedgerState = {
      ...initial.budget,
      reserved: amounts(10),
      reservations: [first]
    };
    const second = reservation("second", 20, new Date(2_000).toISOString());
    const finalLedger: BudgetLedgerState = {
      ...legacyReserved,
      consumed: amounts(10),
      reserved: amounts(),
      reservations: [
        { ...first, status: "committed", consumed: amounts(10), settledAt: new Date(3_000).toISOString() },
        { ...second, status: "released", settledAt: new Date(4_000).toISOString() }
      ]
    };
    const events = [
      envelope(1, "budget.reserved", { reservationId: "first", ledger: legacyReserved }),
      envelope(2, "budget.reserved", {
        reservationId: "second",
        mutation: {
          schemaVersion: 1,
          kind: "reserve",
          reservation: second,
          totals: { consumed: amounts(), reserved: amounts(30) }
        }
      }),
      envelope(3, "budget.committed", {
        reservationId: "first",
        mutation: {
          schemaVersion: 1,
          kind: "settle",
          reservationId: "first",
          status: "committed",
          consumed: amounts(10),
          settledAt: new Date(3_000).toISOString(),
          totals: { consumed: amounts(10), reserved: amounts(20) }
        }
      }),
      envelope(4, "budget.released", { reservationId: "second", ledger: finalLedger })
    ];

    expect(events.every(isAgentEventEnvelope)).toBe(true);
    expect(rehydrate(initial, events).budget).toEqual(finalLedger);
  });

  it("fails closed on compact mutations whose post totals or limit delta do not match", () => {
    const initial = createKernelState({
      sessionId: "budget-session",
      runId: "budget-run",
      mode: "change",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60_000).toISOString()
    });
    const corruptReservation = reservation("corrupt", 10, new Date(1_000).toISOString());
    const corruptReserve = envelope(1, "budget.reserved", {
      reservationId: "corrupt",
      mutation: {
        schemaVersion: 1,
        kind: "reserve",
        reservation: corruptReservation,
        totals: { consumed: amounts(), reserved: amounts(9) }
      }
    });
    const increase = {
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      modelTurns: 0,
      toolCalls: 2,
      children: 0,
      maxDepth: 0
    };
    const limits = { ...initial.budget.limits, toolCalls: initial.budget.limits.toolCalls + 1 };
    const corruptLimit = envelope(2, "budget.limit_increased", {
      mutation: { schemaVersion: 1, kind: "limit", increase, limits }
    }, "user");

    expect(isAgentEventEnvelope(corruptReserve)).toBe(true);
    expect(isAgentEventEnvelope(corruptLimit)).toBe(true);
    expect(() => rehydrate(initial, [corruptReserve])).toThrow(/invalid budget\.reserved transition/iu);
    expect(() => rehydrate(initial, [corruptLimit])).toThrow(/invalid budget\.limit_increased transition/iu);
    const wrongAuthority = { ...corruptLimit, eventId: "runtime-limit", authority: "runtime" as const };
    expect(isAgentEventEnvelope(wrongAuthority)).toBe(false);
    expect(() => rehydrate(initial, [wrongAuthority])).toThrow(/authority must be 'user'/iu);
  });

  it("rejects non-runtime accounting authority and forged legacy ledger replacement", () => {
    const initial = createKernelState({
      sessionId: "budget-session",
      runId: "budget-run",
      mode: "change",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60_000).toISOString()
    });
    const active = reservation("active", 10, new Date(1_000).toISOString());
    const reservedLedger: BudgetLedgerState = {
      ...initial.budget,
      reserved: amounts(10),
      reservations: [active]
    };
    const reserve = envelope(1, "budget.reserved", {
      reservationId: active.reservationId,
      ledger: reservedLedger
    });
    const forged = envelope(2, "budget.released", {
      reservationId: "missing",
      ledger: createBudgetLedger(reservedLedger.limits)
    });
    const toolAuthored = { ...forged, eventId: "tool-budget", authority: "tool" as const };

    expect(isAgentEventEnvelope(toolAuthored)).toBe(false);
    expect(() => rehydrate(initial, [reserve, forged])).toThrow(/legacy full-ledger state/iu);
  });

  it("does not let a repeated session.created event reset an established ledger", () => {
    const initial = createKernelState({
      sessionId: "budget-session",
      runId: "budget-run",
      mode: "change",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60_000).toISOString()
    });
    const created = envelope(1, "session.created", {
      workspacePath: ".",
      mode: "change",
      title: "budget",
      writeScope: [],
      strictWriteScope: false,
      modelRole: "orchestrator",
      budgetLimits: initial.budget.limits
    });
    const active = reservation("active", 10, new Date(2_000).toISOString());
    const reserve = envelope(2, "budget.reserved", {
      reservationId: active.reservationId,
      mutation: {
        schemaVersion: 1,
        kind: "reserve",
        reservation: active,
        totals: { consumed: amounts(), reserved: amounts(10) }
      }
    });
    const repeated = { ...created, seq: 3, eventId: "repeated-created" };

    expect(isAgentEventEnvelope(created)).toBe(true);
    expect(isAgentEventEnvelope(repeated)).toBe(true);
    expect(() => rehydrate(initial, [created, reserve, repeated])).toThrow(/cannot reset an established ledger/iu);
  });

  it("validates reservation lifecycle invariants and aggregate totals", () => {
    const ledger = createBudgetLedger();
    const active = reservation("active", 10, new Date(1_000).toISOString());
    const released = {
      ...active,
      reservationId: "released",
      status: "released" as const,
      settledAt: new Date(2_000).toISOString()
    };
    const committed = {
      ...active,
      reservationId: "committed",
      status: "committed" as const,
      consumed: amounts(4),
      settledAt: new Date(3_000).toISOString()
    };
    const valid: BudgetLedgerState = {
      ...ledger,
      reserved: amounts(10),
      consumed: amounts(4),
      reservations: [active, released, committed]
    };

    expect(isBudgetLedgerSemanticallyValid(valid)).toBe(true);
    expect(isBudgetLedgerSemanticallyValid(null)).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({ ...valid, reservations: [active, active] })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({
      ...valid,
      reservations: [{ ...active, settledAt: new Date(4_000).toISOString() }, released, committed]
    })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({
      ...valid,
      reservations: [{ ...active, consumed: amounts(1) }, released, committed]
    })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({
      ...valid,
      reservations: [active, { ...released, settledAt: undefined }, committed]
    })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({
      ...valid,
      reservations: [active, { ...released, consumed: amounts(1) }, committed]
    })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({
      ...valid,
      reservations: [active, released, { ...committed, settledAt: undefined }]
    })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({ ...valid, reserved: amounts(9) })).toBe(false);
    expect(isBudgetLedgerSemanticallyValid({ ...valid, consumed: amounts(5) })).toBe(false);
  });

  it("applies each compact mutation and rejects malformed lifecycle steps", () => {
    const initial = createBudgetLedger({ ...createBudgetLedger().limits, inputTokens: 20 });
    const active = reservation("active", 10, new Date(1_000).toISOString());
    const reserveMutation = {
      schemaVersion: 1 as const,
      kind: "reserve" as const,
      reservation: active,
      totals: { reserved: amounts(10), consumed: amounts() }
    };
    const reserved = applyBudgetMutationV1(initial, reserveMutation)!;
    expect(reserved.reservations).toHaveLength(1);
    expect(applyBudgetMutationV1(initial, {
      ...reserveMutation,
      reservation: { ...active, status: "released", settledAt: new Date(2_000).toISOString() }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(initial, {
      ...reserveMutation,
      reservation: { ...active, consumed: amounts(1) }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(reserved, reserveMutation)).toBeUndefined();
    expect(applyBudgetMutationV1(initial, {
      ...reserveMutation,
      reservation: { ...active, requested: amounts(21) },
      totals: { reserved: amounts(21), consumed: amounts() }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(initial, {
      ...reserveMutation,
      totals: { reserved: amounts(9), consumed: amounts() }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(initial, {
      ...reserveMutation,
      totals: { reserved: amounts(10), consumed: amounts(1) }
    })).toBeUndefined();

    const bound = applyBudgetMutationV1(reserved, {
      schemaVersion: 1,
      kind: "bind",
      reservationId: "active",
      ownerId: "bound-owner"
    })!;
    expect(bound.reservations[0]?.ownerId).toBe("bound-owner");
    expect(applyBudgetMutationV1(reserved, {
      schemaVersion: 1,
      kind: "bind",
      reservationId: "missing",
      ownerId: "owner"
    })).toBeUndefined();
    expect(applyBudgetMutationV1({
      ...reserved,
      reservations: [{ ...active, status: "committed", settledAt: new Date(2_000).toISOString() }]
    }, {
      schemaVersion: 1,
      kind: "bind",
      reservationId: "active",
      ownerId: "owner"
    })).toBeUndefined();

    expect(applyBudgetMutationV1(reserved, {
      schemaVersion: 1,
      kind: "settle",
      reservationId: "missing",
      status: "released",
      consumed: amounts(),
      settledAt: new Date(2_000).toISOString(),
      totals: { reserved: amounts(), consumed: amounts() }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(reserved, {
      schemaVersion: 1,
      kind: "settle",
      reservationId: "active",
      status: "released",
      consumed: amounts(1),
      settledAt: new Date(2_000).toISOString(),
      totals: { reserved: amounts(), consumed: amounts() }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(reserved, {
      schemaVersion: 1,
      kind: "settle",
      reservationId: "active",
      status: "committed",
      consumed: amounts(4),
      settledAt: new Date(2_000).toISOString(),
      totals: { reserved: amounts(1), consumed: amounts(4) }
    })).toBeUndefined();
    const committed = applyBudgetMutationV1(reserved, {
      schemaVersion: 1,
      kind: "settle",
      reservationId: "active",
      status: "committed",
      consumed: amounts(4),
      settledAt: new Date(2_000).toISOString(),
      totals: { reserved: amounts(), consumed: amounts(4) }
    })!;
    expect(committed.consumed.inputTokens).toBe(4);

    const increase = {
      inputTokens: 1,
      outputTokens: 0,
      costMicroUsd: 0,
      modelTurns: 0,
      toolCalls: 0,
      children: 0,
      maxDepth: 0
    };
    expect(applyBudgetMutationV1(initial, {
      schemaVersion: 1,
      kind: "limit",
      increase: { ...increase, inputTokens: 0 },
      limits: initial.limits
    })).toBeUndefined();
    expect(applyBudgetMutationV1(initial, {
      schemaVersion: 1,
      kind: "limit",
      increase,
      limits: { ...initial.limits, inputTokens: initial.limits.inputTokens + 2 }
    })).toBeUndefined();
    expect(applyBudgetMutationV1(initial, {
      schemaVersion: 1,
      kind: "limit",
      increase,
      limits: { ...initial.limits, inputTokens: initial.limits.inputTokens + 1 }
    })?.limits.inputTokens).toBe(21);
  });

  it("replays bind, commit, and limit legacy ledgers without accepting forged shapes", () => {
    const initial = createBudgetLedger({ ...createBudgetLedger().limits, inputTokens: 20 });
    const active = reservation("active", 10, new Date(1_000).toISOString());
    const reserved: BudgetLedgerState = { ...initial, reserved: amounts(10), reservations: [active] };
    const boundReservation = { ...active, ownerId: "bound-owner" };
    const bound: BudgetLedgerState = { ...reserved, reservations: [boundReservation] };
    const committedReservation = {
      ...boundReservation,
      status: "committed" as const,
      consumed: amounts(4),
      settledAt: new Date(2_000).toISOString()
    };
    const committed: BudgetLedgerState = {
      ...bound,
      reserved: amounts(),
      consumed: amounts(4),
      reservations: [committedReservation]
    };
    const increased: BudgetLedgerState = {
      ...committed,
      limits: { ...committed.limits, inputTokens: committed.limits.inputTokens + 2 }
    };
    const events = [
      envelope(1, "budget.reserved", { reservationId: "active", ledger: reserved }),
      envelope(2, "budget.reservation_bound", {
        reservationId: "active", ownerId: "bound-owner", ledger: bound
      }),
      envelope(3, "budget.committed", { reservationId: "active", ledger: committed }),
      envelope(4, "budget.limit_increased", {
        previousLimits: committed.limits,
        increase: { inputTokens: 2 },
        ledger: increased
      }, "user")
    ];
    let ledger: BudgetLedgerState | undefined = initial;
    for (const event of events) ledger = replayBudgetLedgerEvent(ledger, event);
    expect(ledger).toEqual(increased);

    expect(() => replayBudgetLedgerEvent(reserved, envelope(5, "budget.reservation_bound", {
      reservationId: "active", ownerId: 1, ledger: bound
    }))).toThrow(/legacy full-ledger state/iu);
    expect(() => replayBudgetLedgerEvent(committed, envelope(6, "budget.limit_increased", {
      previousLimits: committed.limits,
      increase: { inputTokens: -1 },
      ledger: increased
    }, "user"))).toThrow(/legacy full-ledger state/iu);
  });

  it("initializes session ledgers once and validates declared limits and authority", () => {
    const created = envelope(1, "session.created", {
      workspacePath: ".", mode: "change", title: "budget", writeScope: [], strictWriteScope: false,
      modelRole: "orchestrator"
    });
    const initial = replayBudgetLedgerEvent(undefined, created)!;
    expect(isBudgetLedgerSemanticallyValid(initial)).toBe(true);
    expect(replayBudgetLedgerEvent(initial, created)).toBe(initial);
    expect(replayBudgetLedgerEvent(initial, envelope(2, "message.added", {}))).toBe(initial);
    expect(() => replayBudgetLedgerEvent(undefined, { ...created, authority: "user" })).toThrow(/runtime authority/iu);
    expect(() => replayBudgetLedgerEvent(undefined, {
      ...created,
      payload: { ...(created.payload as object), budgetLimits: { ...initial.limits, inputTokens: -1 } }
    })).toThrow(/initial budget limits are invalid/iu);
    expect(() => replayBudgetLedgerEvent(initial, {
      ...created,
      payload: {
        ...(created.payload as object),
        budgetLimits: { ...initial.limits, inputTokens: initial.limits.inputTokens + 1 }
      }
    })).toThrow(/declared limits do not match/iu);
  });
});
