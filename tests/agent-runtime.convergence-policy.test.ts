import { describe, expect, it } from "vitest";
import {
  createBudgetLedger,
  type AgentEventEnvelope,
  type AgentEventType,
  type BudgetLimits,
  type JsonValue,
  type ToolDescriptor
} from "../packages/agent-protocol/src/index.js";
import { evolve } from "../packages/agent-kernel/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  candidateReviewerRequestReserve,
  convergenceAdmissionFailure,
  deadlineForecast,
  monotonicBudgetStage
} from "../packages/agent-runtime/src/convergence-policy.js";
import { reviewBasisDigest } from "../packages/agent-runtime/src/mutation-evidence.js";
import {
  budgetStageForCapacity,
  resourceBudgetStageForCapacity
} from "../packages/agent-runtime/src/model-tool-capabilities.js";
import { descriptorsForBudgetStage } from "../packages/agent-runtime/src/model-budget-convergence.js";
import {
  maximumBudgetStage,
  stableBudgetPreparation
} from "../packages/agent-runtime/src/model-budget-stability.js";
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

function kernelEvent(
  state: RuntimeSession["durable"]["state"],
  type: AgentEventType,
  payload: JsonValue,
  authority: AgentEventEnvelope["authority"] = "runtime"
): AgentEventEnvelope {
  return {
    schemaVersion: 3,
    seq: state.lastSeq + 1,
    eventId: `event-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    authority,
    payload
  };
}

function reduce(
  state: RuntimeSession["durable"]["state"],
  type: AgentEventType,
  payload: JsonValue,
  authority?: AgentEventEnvelope["authority"]
): RuntimeSession["durable"]["state"] {
  return evolve(state, kernelEvent(state, type, payload, authority));
}

function stateWithActionDebt(count: 2 | 3): RuntimeSession["durable"]["state"] {
  let state = runtimeSessionFixture().durable.state;
  state = reduce(state, "user.message", { text: "inspect the durable input" });
  for (let turnId = 1; turnId <= count; turnId += 1) {
    const effectRevision = state.revision;
    state = reduce(state, "model.started", { provider: "test", model: "test", turnId, effectRevision });
    state = reduce(state, "diagnostic", {
      kind: "model.tool_policy",
      turnId,
      effectRevision,
      allowedToolNames: ["read"],
      terminalOnly: false
    });
    const callId = `read-${turnId}`;
    const call = { id: callId, name: "read", arguments: { path: "stable.txt" } };
    state = reduce(state, "model.completed", {
      model: "test",
      turnId,
      effectRevision,
      text: "",
      finishReason: "tool_calls",
      message: { role: "assistant", content: "", toolCalls: [call] },
      toolCalls: [call],
      usage: {}
    });
    const pending = state.pendingTools.find((item) => item.request.callId === callId);
    if (!pending) continue;
    state = reduce(state, "tool.started", { callId, name: "read", ...pending.modelTurn });
    state = reduce(state, "tool.completed", {
      callId,
      name: "read",
      ...pending.modelTurn,
      ok: true,
      output: "stable",
      outcome: { status: "succeeded", output: "stable", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      actualEffects: ["filesystem.read"],
      artifacts: [],
      diagnostics: [],
      evidence: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.001Z"
    }, "tool");
  }
  return state;
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

  it("reserves a future candidate review despite a current workspace review", () => {
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
      evidenceId: "readme-delta",
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      kind: "workspace_delta",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime", id: "checkpoint" },
      summary: "README changed",
      data: {
        checkpointId: "checkpoint",
        delta: { added: [], modified: ["README.md"], deleted: [] },
        reviewDiff: "--- a/README.md\n+++ b/README.md\n-old\n+new",
        reviewDiffPaths: ["README.md"]
      }
    }, {
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
    const workspaceBasis = reviewBasisDigest(target);
    target.durable.state.evidence.push({
      evidenceId: "workspace-approval",
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      kind: "review",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime", id: "reviewer" },
      summary: "workspace approved",
      data: {
        reviewerId: "reviewer",
        verdict: "approved",
        findings: [],
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        reviewBasisDigest: workspaceBasis,
        reviewBasisVersion: 3,
        validationEvidenceIds: ["acceptance-proof"]
      }
    });

    expect(deadlineForecast(target)).toMatchObject({
      nextModelEstimateMs: 15_000,
      reviewerEstimateMs: 50_000,
      observedCycleEstimateMs: 0,
      terminalActionReserveMs: 75_250,
      terminalStageReserveMs: 150_500
    });

    target.durable.state.budget = createBudgetLedger(limits({
      inputTokens: 10_000,
      outputTokens: 10_000,
      modelTurns: 1
    }));
    expect(convergenceAdmissionFailure(target, {
      kind: "model",
      stage: "terminal",
      futureBudgetReserve: { modelTurns: 1 }
    }))
      .toMatchObject({ kind: "recoverable_failure", code: "budget_exhausted" });
  });

  it("reserves pure-text review time and removes it after an advisory waiver", () => {
    const documentationTarget = (waived: boolean): RuntimeSession => {
      const target = runtimeSessionFixture();
      target.durable.state.deadlineRemainingMs = 60_000;
      target.durable.state.mutationFrontier = {
        revision: 1,
        baselineManifestDigest: "0".repeat(64),
        currentStateDigest: "a".repeat(64),
        changedPaths: ["README.md"],
        sourceCheckpointIds: ["checkpoint"]
      };
      target.durable.state.evidence.push({
        evidenceId: "documentation-delta",
        sessionId: target.identity.sessionId,
        runId: target.durable.runId,
        kind: "workspace_delta",
        status: "passed",
        createdAt: "2026-01-01T00:00:00.000Z",
        producer: { authority: "runtime", id: "checkpoint" },
        summary: "README changed",
        data: {
          checkpointId: "checkpoint",
          delta: { added: [], modified: ["README.md"], deleted: [] },
          reviewDiff: "--- a/README.md\n+++ b/README.md\n-old\n+new",
          reviewDiffPaths: ["README.md"]
        }
      });
      if (waived) target.durable.state.evidence.push({
        evidenceId: "review-waiver",
        sessionId: target.identity.sessionId,
        runId: target.durable.runId,
        kind: "user_waiver",
        status: "informational",
        createdAt: "2026-01-01T00:00:01.000Z",
        producer: { authority: "user" },
        summary: "review waived",
        data: { scope: "review", reason: "user chose advisory waiver", checkpointId: "checkpoint" }
      });
      return target;
    };

    const reviewable = documentationTarget(false);
    expect(candidateReviewerRequestReserve(reviewable)).toBe(1);
    expect(deadlineForecast(reviewable)).toMatchObject({
      stage: "converge",
      reviewerEstimateMs: 15_000,
      terminalActionReserveMs: 40_250
    });

    const waived = documentationTarget(true);
    expect(candidateReviewerRequestReserve(waived)).toBe(0);
    expect(deadlineForecast(waived)).toMatchObject({
      stage: "normal",
      reviewerEstimateMs: 0,
      terminalActionReserveMs: 25_250
    });
    waived.durable.state.budget = createBudgetLedger(limits({
      inputTokens: 10_000,
      outputTokens: 10_000,
      modelTurns: 1
    }));
    expect(convergenceAdmissionFailure(waived, { kind: "model", stage: "normal" })).toBeNull();
  });

  it("re-quotes contracted stages before latching resource convergence", async () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 600_000;
    const plan = {
      messages: [], included: [], omitted: [],
      budget: { contextWindowTokens: 1_000, outputReserveTokens: 100, usableInputTokens: 900 },
      omittedHistoryTurns: 0, latestHistoryBlockTokens: 0,
      cacheMode: "proactive_window" as const, historyTokenLimit: 0, dynamicSuffixTokens: 0
    };
    const prepared = (stage: "normal" | "converge" | "terminal") => ({
      plan,
      turn: {
        messages: [], tools: [],
        outputReserveTokens: stage === "normal" ? 100 : stage === "converge" ? 20 : 5,
        budget: {
          estimatedInputTokens: stage === "normal" ? 100 : stage === "converge" ? 50 : 10,
          reserved: {
            inputTokens: stage === "normal" ? 100 : stage === "converge" ? 50 : 10,
            outputTokens: stage === "normal" ? 100 : stage === "converge" ? 20 : 5,
            costMicroUsd: stage === "normal" ? 50 : stage === "converge" ? 20 : 5,
            modelTurns: 1
          },
          reservedAttempts: 1,
          attemptReservations: [{
            inputTokens: stage === "normal" ? 100 : stage === "converge" ? 50 : 10,
            outputTokens: stage === "normal" ? 100 : stage === "converge" ? 20 : 5,
            costMicroUsd: stage === "normal" ? 50 : stage === "converge" ? 20 : 5
          }]
        }
      }
    });
    const initial = prepared("normal");
    const result = await stableBudgetPreparation(
      initial,
      deadlineForecast(target),
      "normal",
      false,
      async (stage) => prepared(stage),
      async (candidate) => ({
        inputTokens: candidate.turn.outputReserveTokens * 2,
        outputTokens: candidate.turn.outputReserveTokens * 2,
        costMicroUsd: candidate.turn.outputReserveTokens,
        modelTurns: 1,
        toolCalls: 0,
        children: 0
      }),
      {
        inputTokens: 250, outputTokens: 250, costMicroUsd: 120,
        modelTurns: 3, toolCalls: 0, children: 0
      }
    );

    expect(result).toMatchObject({ stage: "converge", resourceStage: "converge" });
    expect(result.prepared.turn.outputReserveTokens).toBe(20);

    target.durable.state.repeatedToolBatchCount = 2;
    const debtForecast = deadlineForecast(target);
    const debtMinimum = monotonicBudgetStage(debtForecast, "normal");
    const noReviewerReserve = async () => ({
      inputTokens: 0, outputTokens: 0, costMicroUsd: 0,
      modelTurns: 0, toolCalls: 0, children: 0
    });
    const ampleBudget = {
      inputTokens: 1_000, outputTokens: 1_000, costMicroUsd: 1_000,
      modelTurns: 3, toolCalls: 0, children: 0
    };
    const debtResult = await stableBudgetPreparation(
      prepared(debtMinimum), debtForecast, debtMinimum, false,
      async (stage) => prepared(stage), noReviewerReserve, ampleBudget
    );
    const debtResourceStage = monotonicBudgetStage(debtForecast, debtResult.resourceStage);
    expect(debtResult).toMatchObject({ stage: "converge", resourceStage: "normal" });
    expect(maximumBudgetStage(debtResourceStage, debtResult.stage)).toBe("converge");

    // A trusted-progress reducer clears action debt. Since only the resource
    // stage was latched, the next preparation returns to a normal contract.
    target.durable.state.repeatedToolBatchCount = 0;
    const recoveredForecast = deadlineForecast(target);
    const recoveredMinimum = monotonicBudgetStage(recoveredForecast, "normal");
    const recovered = await stableBudgetPreparation(
      prepared(recoveredMinimum), recoveredForecast, recoveredMinimum, false,
      async (stage) => prepared(stage), noReviewerReserve, ampleBudget
    );
    expect(recovered).toMatchObject({ stage: "normal", resourceStage: "normal" });
    expect(recovered.prepared.turn.outputReserveTokens).toBe(100);

    target.durable.state.convergenceStageHighWater = {
      runId: target.durable.runId,
      deadline: "normal",
      budget: "terminal"
    };
    const restored = runtimeSessionFixture({ state: structuredClone(target.durable.state) });
    const restoredForecast = deadlineForecast(restored);
    const restoredMinimum = monotonicBudgetStage(restoredForecast, "normal");
    const restoredResult = await stableBudgetPreparation(
      prepared(restoredMinimum),
      restoredForecast,
      restoredMinimum,
      false,
      async (stage) => prepared(stage),
      noReviewerReserve,
      ampleBudget
    );

    expect(restoredMinimum).toBe("terminal");
    expect(restoredResult).toMatchObject({ stage: "terminal", resourceStage: "terminal" });
    expect(restoredResult.prepared.turn.outputReserveTokens).toBe(5);
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

    target.durable.state = evolve(target.durable.state, {
      schemaVersion: 3,
      seq: target.durable.state.lastSeq + 1,
      eventId: "deadline-high-water",
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "diagnostic",
      authority: "runtime",
      payload: {
        kind: "deadline.stage",
        stage: "converge",
        budgetStage: "terminal",
        resourceBudgetStage: "terminal",
        budgetStageSource: "resource",
        remainingMs: 50_500,
        nextModelEstimateMs: 15_000,
        nextConvergenceModelEstimateMs: 15_000,
        outputReserveTokens: 4_096
      }
    });
    const restored = runtimeSessionFixture({ state: structuredClone(target.durable.state) });
    restored.durable.state.deadlineRemainingMs = 600_000;
    expect(deadlineForecast(restored).stage).toBe("converge");
    expect(budgetStageForCapacity(deadlineForecast(restored), 3)).toBe("terminal");

    target.durable.runId = "next-run";
    target.durable.state.runId = "next-run";
    const nextRun = deadlineForecast(target);
    expect(nextRun.stage).toBe("normal");
    expect(budgetStageForCapacity(nextRun, 3)).toBe("normal");
  });

  it("treats semantic action debt as a transient focused-action then terminal stage", () => {
    const target = runtimeSessionFixture();
    target.durable.state.deadlineRemainingMs = 600_000;
    target.durable.state.repeatedToolBatchCount = 2;

    const forecast = deadlineForecast(target);
    expect(forecast).toMatchObject({ stage: "normal", actionDebt: 2 });
    expect(budgetStageForCapacity(forecast, 3)).toBe("converge");

    target.durable.state.repeatedToolBatchCount = 0;
    expect(budgetStageForCapacity(deadlineForecast(target), 3)).toBe("normal");

    target.durable.state.repeatedToolBatchCount = 3;
    const terminalStage = budgetStageForCapacity(deadlineForecast(target), 3);
    expect(terminalStage).toBe("terminal");
    const descriptor = (name: string, effect: ToolDescriptor["possibleEffects"][number]): ToolDescriptor => ({
      name,
      description: name,
      inputSchema: {},
      possibleEffects: [effect],
      executionMode: "sequential",
      resourceKeys: [],
      approval: "auto",
      idempotent: true,
      timeoutMs: 1_000
    });
    const mixedTerminal: ToolDescriptor = {
      ...descriptor("mixed_terminal_writer", "outcome.propose"),
      possibleEffects: ["outcome.propose", "filesystem.write"]
    };
    const broadMaximumTerminal: ToolDescriptor = {
      ...descriptor("broad_maximum_terminal_writer", "outcome.propose"),
      maximumEffects: ["outcome.propose", "filesystem.write"]
    };
    const runtimeFinalize = descriptor("runtime_finalize", "outcome.propose");
    const ordinaryDescriptors = [
      descriptor("read", "filesystem.read"),
      mixedTerminal,
      broadMaximumTerminal,
      descriptor("report_blocked", "outcome.report_blocked"),
      descriptor("request_user_input", "outcome.request_input")
    ];
    expect(descriptorsForBudgetStage(
      ordinaryDescriptors,
      terminalStage,
      [runtimeFinalize]
    ).map((item) => item.name)).toEqual([
      "runtime_finalize", "report_blocked", "request_user_input"
    ]);
    expect(descriptorsForBudgetStage(
      ordinaryDescriptors,
      "normal",
      [runtimeFinalize]
    ).map((item) => item.name)).not.toContain("runtime_finalize");
  });

  it.each([2, 3] as const)(
    "does not persist action-debt stage %s across restore after trusted progress",
    (debt) => {
      const target = runtimeSessionFixture({ state: stateWithActionDebt(debt) });
      target.durable.state.deadlineRemainingMs = 600_000;
      const before = deadlineForecast(target);
      const resourceBudgetStage = resourceBudgetStageForCapacity(before, 3);
      const budgetStage = budgetStageForCapacity(before, 3);
      expect(before.actionDebt).toBe(debt);
      expect(resourceBudgetStage).toBe("normal");
      expect(budgetStage).toBe(debt === 2 ? "converge" : "terminal");

      target.durable.state = reduce(target.durable.state, "diagnostic", {
        kind: "deadline.stage",
        stage: before.stage,
        budgetStage,
        resourceBudgetStage,
        budgetStageSource: "action_debt",
        remainingMs: before.remainingMs,
        nextModelEstimateMs: before.nextModelEstimateMs,
        nextConvergenceModelEstimateMs: before.nextConvergenceModelEstimateMs,
        outputReserveTokens: 4_096
      });
      expect(target.durable.state.convergenceStageHighWater?.budget).toBe("normal");

      const restored = runtimeSessionFixture({ state: structuredClone(target.durable.state) });
      restored.durable.state.deadlineRemainingMs = 600_000;
      restored.durable.state = reduce(restored.durable.state, "evidence.recorded", {
        evidenceId: `new-input-${debt}`,
        sessionId: restored.identity.sessionId,
        runId: restored.durable.runId,
        kind: "input_access",
        status: "passed",
        createdAt: "2026-01-01T00:00:01.000Z",
        producer: { authority: "runtime" },
        summary: "new durable input",
        data: { path: `new-${debt}.txt`, scope: "workspace", sha256: "a".repeat(64), byteLength: 1 }
      });
      const recovered = deadlineForecast(restored);
      expect(recovered).toMatchObject({ stage: "normal", actionDebt: 0 });
      expect(budgetStageForCapacity(recovered, 3)).toBe("normal");
    }
  );

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
