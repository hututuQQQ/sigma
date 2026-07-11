import { describe, expect, it } from "vitest";
import type { CheckpointManager } from "../packages/agent-checkpoint/src/index.js";
import {
  createBudgetLedger,
  isPlanGraph,
  type AgentEventEnvelope,
  type BudgetLimits,
  type PlanGraph
} from "../packages/agent-protocol/src/index.js";
import {
  BudgetController,
  BudgetExceededError
} from "../packages/agent-runtime/src/budget-controller.js";
import { assertPlanTransition } from "../packages/agent-runtime/src/plan-policy.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";

function random(seed = 0x51_6d_61): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function limits(): BudgetLimits {
  return {
    inputTokens: 100_000,
    outputTokens: 10_000,
    costMicroUsd: 10_000_000,
    modelTurns: 1_000,
    toolCalls: 1_000,
    children: 32,
    maxDepth: 4
  };
}

function session(): RuntimeSession {
  return {
    sessionId: "property-session",
    runId: "property-run",
    state: { budget: createBudgetLedger(limits()) }
  } as RuntimeSession;
}

function graph(size: number, next: () => number): PlanGraph {
  const nodes = Array.from({ length: size }, (_, index) => ({
    id: `node-${index}`,
    title: `Node ${index}`,
    dependencies: Array.from({ length: index }, (_value, dependency) => dependency)
      .filter(() => next() < 0.18)
      .map((dependency) => `node-${dependency}`),
    status: "pending" as const,
    owner: { kind: "root" as const },
    acceptanceCriteria: ["property holds"],
    evidence: []
  }));
  return { revision: 0, goal: "generated DAG", nodes };
}

describe("V3 plan and budget invariant properties", () => {
  it("accepts generated DAGs and rejects a generated back-edge cycle", () => {
    const next = random();
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const candidate = graph(2 + Math.floor(next() * 30), next);
      expect(isPlanGraph(candidate), `valid iteration ${iteration}`).toBe(true);
      const cyclic = structuredClone(candidate);
      cyclic.nodes[0]!.dependencies = [cyclic.nodes.at(-1)!.id];
      cyclic.nodes.at(-1)!.dependencies = [cyclic.nodes[0]!.id];
      expect(isPlanGraph(cyclic), `cyclic iteration ${iteration}`).toBe(false);
      expect(() => assertPlanTransition(
        candidate,
        { ...candidate, revision: candidate.revision + 2 },
        new Map(),
        false
      )).toThrow("Plan revision must be");
    }
  });

  it("conserves randomized reserve, commit, and release operations", async () => {
    const target = session();
    const next = random(0x42_75_64_67);
    const active = new Map<string, number>();
    let committed = 0;
    const budgets = new BudgetController(async (_session, type, _authority, value) => {
      if (type !== "budget.exhausted") {
        target.state.budget = (value as { ledger: RuntimeSession["state"]["budget"] }).ledger;
      }
      return {} as AgentEventEnvelope;
    });

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const shouldReserve = active.size === 0 || (active.size < 40 && next() < 0.58);
      if (shouldReserve) {
        const amount = 1 + Math.floor(next() * 200);
        const id = await budgets.reserve(target, `property:${iteration}`, { inputTokens: amount });
        active.set(id, amount);
      } else {
        const id = [...active.keys()][Math.floor(next() * active.size)]!;
        const requested = active.get(id)!;
        if (next() < 0.55) {
          const actual = Math.floor(next() * (requested + 1));
          await budgets.commit(target, id, { inputTokens: actual });
          committed += actual;
        } else {
          await budgets.release(target, id);
        }
        active.delete(id);
      }

      const activeTotal = [...active.values()].reduce((total, value) => total + value, 0);
      expect(target.state.budget.reserved.inputTokens).toBe(activeTotal);
      expect(target.state.budget.consumed.inputTokens).toBe(committed);
      expect(target.state.budget.reserved.inputTokens).toBeGreaterThanOrEqual(0);
      expect(committed + activeTotal).toBeLessThanOrEqual(target.state.budget.limits.inputTokens);
    }
  });

  it("never over-allocates randomized concurrent sibling reservations", async () => {
    const target = session();
    target.state.budget.limits.inputTokens = 100;
    const budgets = new BudgetController(async (_session, type, _authority, value) => {
      if (type !== "budget.exhausted") {
        target.state.budget = (value as { ledger: RuntimeSession["state"]["budget"] }).ledger;
      }
      return {} as AgentEventEnvelope;
    });
    const requests = Array.from({ length: 64 }, (_value, index) =>
      budgets.reserve(target, `sibling:${index}`, { inputTokens: 7 }));
    const settled = await Promise.allSettled(requests);
    const accepted = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(accepted).toHaveLength(14);
    expect(rejected).toHaveLength(50);
    expect(rejected.every((item) => item.status === "rejected" && item.reason instanceof BudgetExceededError)).toBe(true);
    expect(target.state.budget.reserved.inputTokens).toBe(98);
    expect(target.state.budget.consumed.inputTokens).toBe(0);
    await Promise.all(accepted.map(async (id) => await budgets.release(target, id)));
    expect(target.state.budget.reserved.inputTokens).toBe(0);
  });

  it("admits exactly maxDepth recursive child reservations and durably rejects the next", async () => {
    for (let initialDepth = 0; initialDepth <= 12; initialDepth += 1) {
      let target = session();
      target.sessionId = `depth-${initialDepth}-0`;
      target.state.budget = createBudgetLedger({ ...limits(), maxDepth: initialDepth });
      const exhausted: Array<{ dimension: string; requested: number; available: number }> = [];
      const budgets = new BudgetController(async (emittedSession, type, _authority, value) => {
        if (type === "budget.exhausted") {
          exhausted.push(value as { dimension: string; requested: number; available: number });
        } else if (typeof value === "object" && value !== null && "ledger" in value) {
          emittedSession.state.budget = (value as { ledger: RuntimeSession["state"]["budget"] }).ledger;
        }
        return {} as AgentEventEnvelope;
      });
      const control = new RuntimeControlService({
        checkpoints: {} as unknown as CheckpointManager,
        budgets,
        emit: async () => ({} as AgentEventEnvelope),
        createArtifact: async () => "artifact",
        readArtifact: async () => "artifact"
      });

      for (let level = 0; level < initialDepth; level += 1) {
        const allocation = await control.reserveChildBudget(target, `child-${level}`, {
          children: target.state.budget.limits.maxDepth - 1,
          maxDepth: target.state.budget.limits.maxDepth - 1
        });
        expect(allocation.maxDepth).toBe(initialDepth - level - 1);
        target = session();
        target.sessionId = `depth-${initialDepth}-${level + 1}`;
        target.state.budget = createBudgetLedger(allocation);
      }

      await expect(control.reserveChildBudget(target, "too-deep", { maxDepth: 1 })).rejects.toMatchObject({
        code: "budget_exhausted",
        dimension: "maxDepth",
        requested: 1,
        available: 0
      });
      expect(exhausted).toEqual([{ dimension: "maxDepth", requested: 1, available: 0 }]);
      expect(target.state.budget.reservations).toEqual([]);
      expect(target.state.budget.reserved).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        modelTurns: 0,
        toolCalls: 0,
        children: 0
      });
    }
  });
});
