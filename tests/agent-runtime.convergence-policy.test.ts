import { describe, expect, it } from "vitest";
import {
  createBudgetLedger,
  type AgentEventEnvelope,
  type BudgetLimits
} from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  convergenceAdmissionFailure,
  deadlineFinalizationReserveMs,
  deadlineForecast
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
  it("keeps an unconfigured whole-run deadline unbounded", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineAt = undefined;
    target.durable.state.deadlineRemainingMs = undefined;
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
    expect(deadlineForecast(target)).toEqual({ stage: "unbounded" });
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toBeNull();
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 1 })).toBeNull();
  });

  it("reserves an adaptive finalization window only for an explicit deadline", () => {
    const target = runtimeSessionFixture();
    target.durable.state.usage = [5_000, 8_000, 12_000].map((latencyMs, index) => ({
      usageId: `usage-${index}`,
      requestId: `request-${index}`,
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      role: target.services.modelRole,
      routeId: "route",
      providerId: target.services.gateway.provider,
      // Routed usage records the catalog spec ID while the gateway exposes
      // the upstream model name. The reserve must still use the sample.
      modelId: `${target.services.gateway.provider}/${target.services.gateway.model}`,
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
    const reserveMs = deadlineFinalizationReserveMs(target);
    expect(reserveMs).toBe(22_000);

    target.durable.state.deadlineRemainingMs = reserveMs;

    expect(deadlineForecast(target)).toEqual({
      stage: "converge",
      remainingMs: reserveMs,
      finalizationReserveMs: reserveMs
    });
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toBeNull();
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 1 })).toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: expect.stringContaining("text-only final response")
    });
    expect(convergenceAdmissionFailure(target, {
      kind: "tool", count: 1, terminalOnly: true
    })).toBeNull();

    target.durable.state.deadlineRemainingMs = reserveMs + 1;
    expect(deadlineForecast(target).stage).toBe("normal");
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
