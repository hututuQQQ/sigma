import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ASSURANCE,
  DEFAULT_PROFILE_BUDGET,
  freezeAgentProfile
} from "../packages/agent-extensions/src/index.js";
import type { ReviewEvidence, UsageRecord } from "../packages/agent-protocol/src/index.js";
import {
  availableAuxiliaryBudget,
  availableOrchestratorBudget,
  currentAuxiliaryUsage,
  mainBudgetWindow,
  rawAvailableBudget,
  reviewRepairActive
} from "../packages/agent-runtime/src/assurance-budget.js";
import { repairEpisodeWindow } from "../packages/agent-runtime/src/repair-episode-policy.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const NOW = "2026-07-24T00:00:00.000Z";

function mutatedSession(reviewMode: "off" | "advisory" | "required" = "required") {
  const session = runtimeSessionFixture({
    services: {
      profile: freezeAgentProfile({
        id: `fixture-${reviewMode}`,
        roleRoutes: {},
        toolAllow: null,
        toolDeny: [],
        skills: [],
        hooks: [],
        permissionMode: "auto",
        budget: { ...DEFAULT_PROFILE_BUDGET },
        mutationPolicy: {
          requirePlanBeforeMutation: false,
          checkpointBeforeMutation: true,
          reviewMode
        },
        assurancePolicy: { ...DEFAULT_PROFILE_ASSURANCE },
        allowedChildProfiles: []
      })
    }
  });
  session.durable.state.budget.limits = {
    inputTokens: 100_000,
    outputTokens: 30_000,
    costMicroUsd: 10_000,
    modelTurns: 20,
    toolCalls: 10,
    children: 1,
    maxDepth: 1
  };
  session.durable.state.mutationFrontier = {
    revision: 1,
    baselineManifestDigest: "0".repeat(64),
    currentStateDigest: "a".repeat(64),
    changedPaths: ["src/change.ts"],
    sourceCheckpointIds: ["checkpoint"]
  };
  return session;
}

function usage(
  session: ReturnType<typeof mutatedSession>,
  requestId: string,
  role: UsageRecord["role"],
  inputTokens: number,
  outputTokens: number,
  costMicroUsd: number,
  attempt = 1
): UsageRecord {
  return {
    usageId: `${requestId}:usage`,
    requestId,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    role,
    routeId: "route",
    providerId: "provider",
    modelId: "model",
    tokenizerId: "tokenizer",
    tokenizerAccuracy: "approximate",
    providerReported: true,
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd,
    latencyMs: 1,
    attempt,
    occurredAt: NOW
  };
}

function failedReview(session: ReturnType<typeof mutatedSession>): ReviewEvidence {
  return {
    evidenceId: "review-failed",
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "review",
    status: "failed",
    createdAt: NOW,
    producer: { authority: "runtime", id: "reviewer" },
    summary: "Repair required.",
    data: {
      schemaVersion: 1,
      reviewerId: "reviewer",
      verdict: "changes_requested",
      findings: [{ actionable: true, severity: "error", summary: "Fix the defect." }],
      criteria: [{
        criterion: "The change is correct.",
        status: "failed",
        evidence: []
      }],
      requiredValidations: [],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      validationEvidenceIds: [],
      durableEvidenceIds: [],
      actualChecks: []
    }
  };
}

function consumeModelTurns(
  session: ReturnType<typeof mutatedSession>,
  count: number
): void {
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    modelTurns: 0,
    toolCalls: 0,
    children: 0
  };
  const consumed = { ...zero, modelTurns: count };
  session.durable.state.budget = {
    ...session.durable.state.budget,
    consumed,
    reservations: [{
      reservationId: "prior-model-work",
      ownerId: "model:prior",
      status: "committed",
      requested: consumed,
      consumed,
      createdAt: NOW,
      settledAt: NOW
    }]
  };
}

describe("assurance resource reserve", () => {
  it("caps auxiliary usage at 20% and protects required review plus repair turns from ordinary work", () => {
    const session = mutatedSession();

    expect(availableAuxiliaryBudget(session)).toEqual({
      inputTokens: 20_000,
      outputTokens: 6_000,
      costMicroUsd: 2_000,
      modelTurns: 10,
      toolCalls: 0,
      children: 0
    });
    expect(availableOrchestratorBudget(session)).toMatchObject({
      inputTokens: 80_000,
      outputTokens: 24_000,
      costMicroUsd: 8_000,
      modelTurns: 7,
      toolCalls: 2
    });
    consumeModelTurns(session, 10);
    expect(rawAvailableBudget(session).modelTurns).toBe(10);
    expect(availableOrchestratorBudget(session).modelTurns).toBe(0);
  });

  it.each(["advisory", "off"] as const)(
    "does not strand the advertised main-loop budget for %s assurance",
    (reviewMode) => {
      const session = mutatedSession(reviewMode);

      expect(availableAuxiliaryBudget(session).modelTurns).toBe(10);
      expect(availableOrchestratorBudget(session)).toEqual(rawAvailableBudget(session));
      expect(mainBudgetWindow(session)).toEqual({
        available: rawAvailableBudget(session),
        capacity: {
          inputTokens: 100_000,
          outputTokens: 30_000,
          costMicroUsd: 10_000,
          modelTurns: 20,
          toolCalls: 10,
          children: 1
        }
      });

      consumeModelTurns(session, 19);
      expect(rawAvailableBudget(session).modelTurns).toBe(1);
      expect(availableOrchestratorBudget(session).modelTurns).toBe(1);
    }
  );

  it("derives auxiliary enforcement from durable usage without a refresh window", () => {
    const session = mutatedSession();
    session.durable.state.usage.push(
      usage(session, "strategy:run:one", "planner", 1_000, 500, 100),
      usage(session, "review:one", "reviewer", 2_000, 600, 200, 2)
    );

    expect(currentAuxiliaryUsage(session)).toMatchObject({
      strategistCalls: 1,
      reviewerCalls: 1,
      modelTurns: 3,
      inputTokens: 3_000,
      outputTokens: 1_100,
      costMicroUsd: 300
    });
    expect(availableAuxiliaryBudget(session)).toMatchObject({
      inputTokens: 17_000,
      outputTokens: 4_900,
      costMicroUsd: 1_700,
      modelTurns: 7
    });

    // Re-reading the ledger is idempotent and cannot double-charge restored
    // auxiliary calls.
    expect(currentAuxiliaryUsage(session)).toEqual(currentAuxiliaryUsage(session));
  });

  it("releases unused assurance and repair reserves after the final substantive review", () => {
    const session = mutatedSession();
    const first = failedReview(session);
    const second = {
      ...failedReview(session),
      evidenceId: "review-failed-final",
      data: {
        ...failedReview(session).data,
        reviewBasisDigest: "c".repeat(64)
      }
    } satisfies ReviewEvidence;
    session.durable.state.evidence.push(first, second);
    session.durable.state.usage.push(
      usage(session, "strategy:run:one", "planner", 1_000, 100, 50),
      usage(session, "review:one", "reviewer", 1_000, 100, 50),
      usage(session, "review:two", "reviewer", 1_000, 100, 50)
    );

    expect(availableAuxiliaryBudget(session)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      modelTurns: 0,
      toolCalls: 0,
      children: 0
    });
    expect(availableOrchestratorBudget(session)).toEqual(rawAvailableBudget(session));
    expect(mainBudgetWindow(session).available).toEqual(rawAvailableBudget(session));
  });

  it("unlocks protected main turns only for an actual review repair", () => {
    const session = mutatedSession();
    consumeModelTurns(session, 10);
    expect(availableOrchestratorBudget(session).modelTurns).toBe(0);

    session.durable.state.evidence.push(failedReview(session));
    expect(availableOrchestratorBudget(session)).toMatchObject({
      inputTokens: 86_666,
      outputTokens: 26_000,
      costMicroUsd: 8_666,
      modelTurns: 4
    });

    session.durable.state.longHorizon.assurance.protectedRepairTurnsRemaining = 1;
    session.durable.state.evidence = [];
    expect(availableOrchestratorBudget(session).modelTurns).toBe(0);
  });

  it("keeps the repair episode active after the failed-review frontier changes", () => {
    const session = mutatedSession();
    consumeModelTurns(session, 10);
    session.durable.state.evidence.push(failedReview(session));
    session.durable.state.mutationFrontier = {
      ...session.durable.state.mutationFrontier,
      revision: 2,
      currentStateDigest: "b".repeat(64),
      changedPaths: ["src/change.ts", "src/repair.ts"]
    };

    expect(reviewRepairActive(session)).toBe(true);
    expect(availableOrchestratorBudget(session).modelTurns).toBe(4);
  });

  it("treats repair tool protection as a floor and closes only at the hard resource boundary", () => {
    const session = mutatedSession();
    session.durable.state.evidence.push(failedReview(session));
    session.durable.state.longHorizon.assurance.protectedRepairTurnsRemaining = 0;

    expect(reviewRepairActive(session)).toBe(true);
    expect(availableOrchestratorBudget(session)).toMatchObject({
      inputTokens: 80_000,
      outputTokens: 24_000,
      costMicroUsd: 8_000,
      modelTurns: 14,
      toolCalls: 10
    });
    expect(availableAuxiliaryBudget(session)).toMatchObject({
      inputTokens: 20_000,
      outputTokens: 6_000,
      costMicroUsd: 2_000,
      modelTurns: 6
    });
    expect(repairEpisodeWindow(session)).toEqual({
      active: true,
      closureRequired: false,
      toolCapableTurnsRemaining: 0,
      toolCallsRemaining: 10,
      protectedToolCallsRemaining: 8
    });

    session.durable.state.longHorizon.assurance.protectedToolCallsRemaining = 0;
    expect(repairEpisodeWindow(session)).toEqual({
      active: true,
      closureRequired: false,
      toolCapableTurnsRemaining: 0,
      toolCallsRemaining: 10,
      protectedToolCallsRemaining: 0
    });

    session.durable.state.budget.consumed.toolCalls =
      session.durable.state.budget.limits.toolCalls;
    expect(repairEpisodeWindow(session)).toEqual({
      active: true,
      closureRequired: true,
      toolCapableTurnsRemaining: 0,
      toolCallsRemaining: 0,
      protectedToolCallsRemaining: 0
    });
  });
});
