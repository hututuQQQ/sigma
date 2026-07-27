import { describe, expect, it, vi } from "vitest";
import {
  createBudgetLedger,
  type AgentEventEnvelope,
  type BudgetLimits
} from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  ACTION_SETTLEMENT_GRACE_MS,
  convergenceAdmissionFailure,
  deadlineForecast,
  openConvergenceActionScope
} from "../packages/agent-runtime/src/convergence-policy.js";
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

function controller(target: RuntimeSession): BudgetController {
  return new BudgetController(async (_session, type, _authority, payload) => {
    if (type === "budget.reserved" || type === "budget.committed") {
      target.durable.state.budget = (payload as {
        ledger: RuntimeSession["durable"]["state"]["budget"];
      }).ledger;
    }
    return {} as AgentEventEnvelope;
  });
}

describe("hard-ledger convergence admission", () => {
  it("keeps latency forecasts telemetry-only while usable action time remains", () => {
    const target = runtimeSessionFixture();
    target.durable.state.usage = [10_000, 30_000, 120_000, 180_000]
      .map((latencyMs, index) => ({
        usageId: `usage-${index}`,
        requestId: `request-${index}`,
        sessionId: target.identity.sessionId,
        runId: target.durable.runId,
        role: target.services.modelRole,
        routeId: "route",
        providerId: "provider",
        modelId: "model",
        tokenizerId: "tokenizer",
        tokenizerAccuracy: "exact" as const,
        providerReported: true,
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 0,
        latencyMs,
        attempt: 1,
        occurredAt: new Date().toISOString()
      }));
    target.durable.state.deadlineRemainingMs = ACTION_SETTLEMENT_GRACE_MS + 1;
    expect(deadlineForecast(target)).toMatchObject({
      stage: "normal",
      remainingMs: ACTION_SETTLEMENT_GRACE_MS + 1,
      usableMs: 1
    });
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toBeNull();
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 1 })).toBeNull();
  });

  it("reserves the convergence window for settlement and pure terminal actions", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = ACTION_SETTLEMENT_GRACE_MS;
    expect(deadlineForecast(target)).toMatchObject({
      stage: "converge",
      usableMs: 0
    });
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("reserved for durable settlement")
    });
    expect(convergenceAdmissionFailure(target, {
      kind: "tool", count: 1
    })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted"
    });
    expect(convergenceAdmissionFailure(target, {
      kind: "tool", count: 1, terminalOnly: true
    })).toBeNull();
  });

  it("classifies an elapsed absolute deadline as a hard stop", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 0;
    expect(deadlineForecast(target).stage).toBe("stop");
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("absolute run deadline")
    });
  });

  it("interrupts admitted work at the convergence boundary without aborting the outer run", () => {
    vi.useFakeTimers();
    try {
      const target = runtimeSessionFixture();
      target.durable.state.deadlineRemainingMs = ACTION_SETTLEMENT_GRACE_MS + 250;
      const outer = new AbortController();
      const scope = openConvergenceActionScope(target, outer.signal, { kind: "model" });

      expect(scope.signal.aborted).toBe(false);
      vi.advanceTimersByTime(249);
      expect(scope.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(scope.signal.aborted).toBe(true);
      expect(outer.signal.aborted).toBe(false);
      expect(scope.signal.reason).toMatchObject({
        name: "ResourceBoundaryError",
        code: "budget_exhausted",
        decisionAuthority: "resource_boundary"
      });
      scope.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles measured resources exactly and refuses only a request the ledger cannot fund", async () => {
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
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toBeNull();
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 2 })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("only 1 tool-call budget remains")
    });

    target.durable.state.budget.consumed.inputTokens =
      target.durable.state.budget.limits.inputTokens;
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("inputTokens")
    });
  });
});
