import { describe, expect, it } from "vitest";
import {
  createBudgetLedger,
  type AgentEventEnvelope,
  type BudgetLimits
} from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import { convergenceAdmissionFailure } from "../packages/agent-runtime/src/convergence-policy.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function limits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return {
    inputTokens: 100,
    outputTokens: 100,
    costMicroUsd: 10_000,
    modelTurns: 2,
    toolCalls: 2,
    children: 0,
    maxDepth: 0,
    ...overrides
  };
}

function event(): AgentEventEnvelope {
  return {} as AgentEventEnvelope;
}

function controller(target: RuntimeSession): BudgetController {
  return new BudgetController(async (_session, type, _authority, payload) => {
    if (type === "budget.reserved" || type === "budget.committed") {
      target.durable.state.budget = (payload as {
        ledger: RuntimeSession["durable"]["state"]["budget"];
      }).ledger;
    }
    return event();
  });
}

describe("unified convergence admission policy", () => {
  it("returns a typed failure before an action that cannot settle inside active time", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 1_000;

    expect(convergenceAdmissionFailure(target, { kind: "model" }, Date.now())).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("Stopped before the hard deadline")
    });
    expect(target.durable.state.budget.reservations).toEqual([]);
  });

  it("settles measured token, model-turn, and tool-call usage exactly before the next admission", async () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 60_000;
    target.durable.state.budget = createBudgetLedger(limits());
    const budgets = controller(target);

    const modelReservation = await budgets.reserve(target, "model:one", {
      inputTokens: 30,
      outputTokens: 10,
      modelTurns: 1
    });
    await budgets.commitMeasured(target, modelReservation, {
      inputTokens: 25,
      outputTokens: 5,
      modelTurns: 1
    });
    const toolReservation = await budgets.reserve(target, "tool:one", { toolCalls: 2 });
    await budgets.commit(target, toolReservation, { toolCalls: 1 });

    expect(target.durable.state.budget.consumed).toMatchObject({
      inputTokens: 25,
      outputTokens: 5,
      modelTurns: 1,
      toolCalls: 1
    });
    expect(target.durable.state.budget.reserved).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      modelTurns: 0,
      toolCalls: 0
    });
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toBeNull();
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 2 })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("only 1 tool-call budget remains")
    });

    target.durable.state.budget.consumed.inputTokens = target.durable.state.budget.limits.inputTokens;
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("inputTokens")
    });
  });
});
