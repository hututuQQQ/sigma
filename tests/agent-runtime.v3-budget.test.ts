import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager } from "../packages/agent-checkpoint/src/index.js";
import {
  createBudgetLedger,
  type AgentEventEnvelope,
  type BudgetLimits
} from "../packages/agent-protocol/src/index.js";
import {
  BudgetController,
  BudgetExceededError
} from "../packages/agent-runtime/src/budget-controller.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { describe, expect, it } from "vitest";

function limits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return {
    inputTokens: 1_000,
    outputTokens: 1_000,
    costMicroUsd: 10_000_000,
    modelTurns: 1_000,
    toolCalls: 1_000,
    children: 32,
    maxDepth: 4,
    ...overrides
  };
}

function session(value: BudgetLimits): RuntimeSession {
  return {
    sessionId: "session",
    runId: "run",
    state: { budget: createBudgetLedger(value), evidence: [] }
  } as unknown as RuntimeSession;
}

function event(): AgentEventEnvelope {
  return {} as AgentEventEnvelope;
}

function controller(target: RuntimeSession): BudgetController {
  return new BudgetController(async (_session, type, _authority, value) => {
    if (type !== "budget.exhausted") {
      target.state.budget = (value as { ledger: RuntimeSession["state"]["budget"] }).ledger;
    }
    return event();
  });
}

describe("V3 shared budget ledger", () => {
  it("allows only an explicit additive user budget increase without resetting usage", async () => {
    const target = session(limits({ inputTokens: 100, maxDepth: 2 }));
    target.state.budget.consumed.inputTokens = 25;
    const authorities: string[] = [];
    const budgets = new BudgetController(async (_session, type, authority, value) => {
      authorities.push(`${type}:${authority}`);
      target.state.budget = (value as { ledger: RuntimeSession["state"]["budget"] }).ledger;
      return event();
    });

    await expect(budgets.increaseLimits(target, { inputTokens: 50, maxDepth: 1 }))
      .resolves.toMatchObject({ inputTokens: 150, maxDepth: 3 });
    expect(target.state.budget.consumed.inputTokens).toBe(25);
    expect(authorities).toEqual(["budget.limit_increased:user"]);
    await expect(budgets.increaseLimits(target, {})).rejects.toThrow(/at least one/iu);
    await expect(budgets.increaseLimits(target, { toolCalls: -1 })).rejects.toThrow("non-negative");
  });

  it("serializes parallel reservations without overspending or going negative", async () => {
    const target = session(limits({ inputTokens: 1_000 }));
    const budgets = controller(target);
    const requests = Array.from({ length: 100 }, (_, index) =>
      budgets.reserve(target, `parallel:${index}`, { inputTokens: 17 }));
    const settled = await Promise.allSettled(requests);
    const reservations = settled.filter((item): item is PromiseFulfilledResult<string> => item.status === "fulfilled");
    expect(reservations).toHaveLength(58);
    expect(target.state.budget.reserved.inputTokens).toBe(986);
    expect(target.state.budget.consumed.inputTokens).toBe(0);
    expect(settled.filter((item) => item.status === "rejected").every((item) =>
      item.status === "rejected" && item.reason instanceof BudgetExceededError)).toBe(true);
    await Promise.all(reservations.map(async (item) => await budgets.release(target, item.value)));
    expect(target.state.budget.reserved.inputTokens).toBe(0);
    expect(target.state.budget.consumed.inputTokens).toBe(0);
  });

  it("settles an interrupted model reservation conservatively and only once", async () => {
    const target = session(limits());
    const budgets = controller(target);
    await budgets.reserve(target, "model:run:7", {
      inputTokens: 120,
      outputTokens: 40,
      costMicroUsd: 900,
      modelTurns: 2
    });
    await expect(budgets.settleInterruptedModel(target, "run:7")).resolves.toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      costMicroUsd: 900,
      modelTurns: 2
    });
    const afterFirst = structuredClone(target.state.budget);
    await expect(budgets.settleInterruptedModel(target, "run:7")).resolves.toEqual(
      afterFirst.reservations[0]?.consumed
    );
    expect(target.state.budget).toEqual(afterFirst);
    expect(target.state.budget.reserved).toMatchObject({ inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
    expect(target.state.budget.consumed).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      costMicroUsd: 900,
      modelTurns: 2
    });
  });

  it("reserves a child's whole allocation and commits only its tree's actual usage", async () => {
    const target = session(limits());
    const budgets = controller(target);
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-budget-control-"));
    const control = new RuntimeControlService({
      checkpoints: new CheckpointManager({ rootDir: root }),
      budgets,
      emit: async () => event(),
      createArtifact: async () => "artifact"
    });
    const allocation = await control.reserveChildBudget(target, "child", {
      inputTokens: 100,
      outputTokens: 80,
      costMicroUsd: 500,
      modelTurns: 10,
      toolCalls: 20,
      children: 2,
      maxDepth: 2
    });
    expect(allocation.maxDepth).toBe(2);
    expect(target.state.budget.reserved).toMatchObject({ inputTokens: 100, outputTokens: 80, children: 3 });
    await control.settleChildBudget(target, "child", {
      inputTokens: 40,
      outputTokens: 7,
      costMicroUsd: 50,
      modelTurns: 3,
      toolCalls: 8,
      children: 1
    });
    expect(target.state.budget.reserved).toMatchObject({ inputTokens: 0, outputTokens: 0, children: 0 });
    expect(target.state.budget.consumed).toMatchObject({
      inputTokens: 40, outputTokens: 7, costMicroUsd: 50, modelTurns: 3, toolCalls: 8, children: 2
    });
  });

  it("narrows a descendant's default allocation to the parent's remaining hard budget", async () => {
    const target = session(limits({
      inputTokens: 500_000,
      outputTokens: 64_000,
      costMicroUsd: 4_000_000,
      modelTurns: 32,
      toolCalls: 256,
      children: 4,
      maxDepth: 3
    }));
    target.state.budget.consumed.inputTokens = 100_000;
    const budgets = controller(target);
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-budget-descendant-"));
    const control = new RuntimeControlService({
      checkpoints: new CheckpointManager({ rootDir: root }), budgets,
      emit: async () => event(), createArtifact: async () => "artifact"
    });
    const child = await control.reserveChildBudget(target, "grandchild");
    expect(child).toMatchObject({
      inputTokens: 400_000,
      outputTokens: 64_000,
      costMicroUsd: 4_000_000,
      modelTurns: 32,
      toolCalls: 256,
      children: 3,
      maxDepth: 2
    });
    expect(target.state.budget.reserved.children).toBe(4);
  });

  it("enforces optimistic plan revisions under concurrent updates", async () => {
    const target = session(limits());
    target.state.plan = {
      revision: 1,
      goal: "initial",
      activeNodeId: "root",
      nodes: [{
        id: "root", title: "root", dependencies: [], status: "in_progress",
        owner: { kind: "root" }, acceptanceCriteria: ["done"], evidence: []
      }]
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-plan-control-"));
    const control = new RuntimeControlService({
      checkpoints: new CheckpointManager({ rootDir: root }),
      budgets: controller(target),
      emit: async (_session, type, _authority, value) => {
        if (type === "plan.updated") {
          await new Promise((resolve) => setTimeout(resolve, 2));
          target.state.plan = structuredClone((value as { plan: RuntimeSession["state"]["plan"] }).plan);
        }
        return event();
      },
      createArtifact: async () => "artifact"
    });
    const port = control.forSession(target);
    const proposed = (goal: string) => ({ ...target.state.plan, revision: 2, goal });
    const results = await Promise.allSettled([
      port.updatePlan({ expectedRevision: 1, plan: proposed("left") }),
      port.updatePlan({ expectedRevision: 1, plan: proposed("right") })
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "plan_revision_conflict" });
    expect(target.state.plan.revision).toBe(2);
  });
});
