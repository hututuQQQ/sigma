import { describe, expect, it } from "vitest";
import { createKernelState, rehydrate } from "../packages/agent-kernel/src/index.js";
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
    expect(isAgentEventEnvelope(repeated)).toBe(false);
    expect(() => rehydrate(initial, [created, reserve, repeated])).toThrow(/session creation must be the first/iu);
  });
});
