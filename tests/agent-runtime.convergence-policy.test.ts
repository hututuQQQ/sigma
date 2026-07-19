import { describe, expect, it } from "vitest";
import {
  createBudgetLedger,
  type AgentEventEnvelope,
  type BudgetLimits
} from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  convergenceAdmissionFailure,
  deadlineForecast
} from "../packages/agent-runtime/src/convergence-policy.js";
import { budgetStageForCapacity } from "../packages/agent-runtime/src/model-tool-capabilities.js";
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
  it("uses the latest eight P90 latencies to enter converge and stop stages", () => {
    const target = runtimeSessionFixture();
    target.durable.state.usage = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 100_000]
      .map((latencyMs, index) => ({
        usageId: `usage-${index}`, requestId: `request-${index}`,
        sessionId: target.identity.sessionId, runId: target.durable.runId,
        role: target.services.modelRole, routeId: "route", providerId: "provider", modelId: "model",
        tokenizerId: "tokenizer", tokenizerAccuracy: "exact" as const, providerReported: true,
        inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, costMicroUsd: 0, latencyMs, attempt: 1,
        occurredAt: new Date().toISOString()
      }));

    target.durable.state.deadlineRemainingMs = 459_999;
    expect(deadlineForecast(target)).toMatchObject({
      stage: "converge", nextModelEstimateMs: 150_000, settlementReserveMs: 10_000
    });
    target.durable.state.deadlineRemainingMs = 159_999;
    expect(deadlineForecast(target)).toMatchObject({
      stage: "converge",
      nextConvergenceModelEstimateMs: 120_000,
      observedCycleEstimateMs: 120_000,
      terminalActionReserveMs: 130_250,
      terminalStageReserveMs: 260_500,
      terminalProjectionThresholdMs: 380_500
    });
    expect(convergenceAdmissionFailure(target, { kind: "model", stage: "terminal" })).toBeNull();
    expect(budgetStageForCapacity(deadlineForecast(target), 3)).toBe("terminal");
    target.durable.state.deadlineRemainingMs = 129_999;
    expect(deadlineForecast(target).stage).toBe("stop");
    expect(convergenceAdmissionFailure(target, { kind: "model" })).toMatchObject({
      kind: "recoverable_failure", code: "budget_exhausted"
    });
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 1 })).toMatchObject({
      kind: "recoverable_failure", code: "budget_exhausted"
    });
    expect(convergenceAdmissionFailure(target, {
      kind: "tool", count: 1, terminalOnly: true
    })).toBeNull();
  });

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

  it("enters convergence early enough to settle durable obligations", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 80_000;
    expect(deadlineForecast(target).stage).toBe("normal");

    target.durable.state.plan = {
      revision: 1,
      goal: "finish safely",
      activeNodeId: "root",
      nodes: [{
        id: "root",
        title: "finish",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["validated"],
        evidence: []
      }]
    };
    target.durable.state.activeProcessIds = ["process-1"];
    target.durable.state.mutationFrontier.changedPaths = ["packages/agent-runtime/src/code.ts"];
    target.durable.state.checkpointHead = {
      checkpointId: "checkpoint",
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      preManifestDigest: "a".repeat(64)
    };

    expect(deadlineForecast(target)).toMatchObject({
      stage: "converge",
      obligations: [
        "plan_incomplete",
        "active_processes",
        "checkpoint_unsettled",
        "validation_incomplete",
        "review_incomplete"
      ]
    });
  });

  it("keeps a fresh short-deadline turn ordinary until the terminal reserve is reached", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 60_000;
    const actionForecast = deadlineForecast(target);
    expect(actionForecast).toMatchObject({
      stage: "normal",
      observedCycleEstimateMs: 0,
      terminalActionReserveMs: 25_250,
      terminalStageReserveMs: 50_500,
      terminalProjectionThresholdMs: 50_500
    });
    expect(budgetStageForCapacity(actionForecast, 3)).toBe("normal");
    expect(convergenceAdmissionFailure(target, { kind: "model", stage: "normal" })).toBeNull();

    target.durable.state.deadlineRemainingMs = 54_000;
    const convergeForecast = deadlineForecast(target);
    expect(convergeForecast.stage).toBe("converge");
    expect(budgetStageForCapacity(convergeForecast, 3)).toBe("converge");
    expect(convergenceAdmissionFailure(target, { kind: "tool", count: 1 })).toBeNull();

    target.durable.state.deadlineRemainingMs = 50_500;
    const terminalForecast = deadlineForecast(target);
    expect(terminalForecast.stage).toBe("converge");
    expect(budgetStageForCapacity(terminalForecast, 3)).toBe("terminal");
    expect(convergenceAdmissionFailure(target, { kind: "model", stage: "terminal" })).toBeNull();
  });

  it("uses observed model latency to project terminal-only tools early", () => {
    const fresh = runtimeSessionFixture();
    fresh.durable.state.deadlineRemainingMs = 90_000;
    expect(deadlineForecast(fresh)).toMatchObject({
      stage: "normal",
      observedCycleEstimateMs: 0,
      terminalProjectionThresholdMs: 50_500
    });
    expect(budgetStageForCapacity(deadlineForecast(fresh), 3)).toBe("normal");

    const measured = runtimeSessionFixture();
    measured.durable.state.deadlineRemainingMs = 90_000;
    measured.durable.state.usage.push({
      usageId: "model-usage", requestId: "model-request",
      sessionId: measured.identity.sessionId, runId: measured.durable.runId,
      role: measured.services.modelRole, routeId: "route", providerId: "provider", modelId: "model",
      tokenizerId: "tokenizer", tokenizerAccuracy: "exact", providerReported: true,
      inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, costMicroUsd: 0, latencyMs: 20_000, attempt: 1,
      occurredAt: "2026-01-01T00:00:00.000Z"
    });
    const measuredForecast = deadlineForecast(measured);
    expect(measuredForecast).toMatchObject({
      stage: "converge",
      nextModelEstimateMs: 30_000,
      nextConvergenceModelEstimateMs: 25_000,
      observedCycleEstimateMs: 25_000,
      terminalActionReserveMs: 35_250,
      terminalStageReserveMs: 70_500,
      terminalProjectionThresholdMs: 95_500
    });
    expect(budgetStageForCapacity(measuredForecast, 3)).toBe("terminal");
  });

  it("reserves reviewer P90 when a successful finalize will trigger advisory review", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 600_000;
    target.durable.state.mutationFrontier = {
      revision: 1,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "a".repeat(64),
      changedPaths: ["README.md"],
      sourceCheckpointIds: []
    };
    target.durable.state.evidence.push({
      evidenceId: "acceptance-proof",
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      kind: "validation",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "tool", id: "validate-call" },
      summary: "acceptance passed",
      data: {
        validator: "command",
        command: "node smoke.mjs",
        exitCode: 0,
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        coveredPaths: ["README.md"],
        claim: {
          kind: "acceptance",
          commandDigest: "f".repeat(64),
          status: "passed",
          strength: "behavioral",
          independence: "cross_method",
          assertionMode: "explicit",
          subject: { projectId: ".", configPaths: [], selectedTests: [], exactFiles: [] }
        }
      }
    });
    target.durable.state.usage.push({
      usageId: "review-usage", requestId: "review-request",
      sessionId: target.identity.sessionId, runId: target.durable.runId,
      role: "reviewer", routeId: "review-route", providerId: "provider", modelId: "reviewer",
      tokenizerId: "tokenizer", tokenizerAccuracy: "exact", providerReported: true,
      inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, costMicroUsd: 0, latencyMs: 40_000, attempt: 1,
      occurredAt: "2026-01-01T00:00:00.000Z"
    });

    expect(deadlineForecast(target)).toMatchObject({
      nextModelEstimateMs: 15_000,
      reviewerEstimateMs: 50_000,
      observedCycleEstimateMs: 0,
      terminalActionReserveMs: 75_250,
      terminalStageReserveMs: 150_500
    });
  });

  it("keeps converge and terminal-only stages monotonic for the live run", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 50_500;

    const constrained = deadlineForecast(target);
    expect(constrained.stage).toBe("converge");
    expect(budgetStageForCapacity(constrained, 3)).toBe("terminal");

    target.durable.state.deadlineRemainingMs = 600_000;
    target.durable.state.evidence.push({
      evidenceId: "late-diagnostic",
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      kind: "diagnostic",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime" },
      summary: "new diagnostic output",
      data: { source: "runtime", diagnostic: { observed: true } }
    });
    const apparentlyRecovered = deadlineForecast(target);
    expect(apparentlyRecovered.stage).toBe("converge");
    expect(budgetStageForCapacity(apparentlyRecovered, 3)).toBe("terminal");

    target.durable.runId = "next-run";
    target.durable.state.runId = "next-run";
    const nextRun = deadlineForecast(target);
    expect(nextRun.stage).toBe("normal");
    expect(budgetStageForCapacity(nextRun, 3)).toBe("normal");
  });

  it("uses semantic action debt to enter a 4K tool-first convergence stage", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 600_000;
    target.durable.state.repeatedToolBatchCount = 2;

    const forecast = deadlineForecast(target);
    expect(forecast).toMatchObject({ stage: "normal", actionDebt: 2 });
    expect(budgetStageForCapacity(forecast, 3)).toBe("converge");

    target.durable.state.repeatedToolBatchCount = 0;
    expect(budgetStageForCapacity(deadlineForecast(target), 3)).toBe("converge");
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
    expect(convergenceAdmissionFailure(target, { kind: "model", stage: "terminal" })).toBeNull();
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
