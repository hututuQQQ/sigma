import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CheckpointManager } from "../packages/agent-checkpoint/src/index.js";
import {
  createBudgetLedger,
  isPlanGraph,
  type AgentEventEnvelope,
  type BudgetLimits,
  type PlanGraph,
  type ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  BudgetController,
  BudgetExceededError
} from "../packages/agent-runtime/src/budget-controller.js";
import { assertPlanTransition } from "../packages/agent-runtime/src/plan-policy.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import { evidenceLedger } from "../packages/agent-runtime/src/model-evidence-ledger.js";
import { planLedger } from "../packages/agent-runtime/src/model-plan-ledger.js";
import { progressCheckpoints } from "../packages/agent-runtime/src/progress-checkpoint.js";
import { materializeRuntimePromptFrame } from "../packages/agent-runtime/src/runtime-prompt-state.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

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

function session(sessionId = "property-session"): RuntimeSession {
  const target = runtimeSessionFixture({ sessionId, runId: "property-run" });
  target.durable.state.budget = createBudgetLedger(limits());
  return target;
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

describe("plan and budget invariant properties", () => {
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
        target.durable.state.budget = (value as { ledger: RuntimeSession["durable"]["state"]["budget"] }).ledger;
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
      expect(target.durable.state.budget.reserved.inputTokens).toBe(activeTotal);
      expect(target.durable.state.budget.consumed.inputTokens).toBe(committed);
      expect(target.durable.state.budget.reserved.inputTokens).toBeGreaterThanOrEqual(0);
      expect(committed + activeTotal).toBeLessThanOrEqual(target.durable.state.budget.limits.inputTokens);
    }
  });

  it("never over-allocates randomized concurrent sibling reservations", async () => {
    const target = session();
    target.durable.state.budget.limits.inputTokens = 100;
    const budgets = new BudgetController(async (_session, type, _authority, value) => {
      if (type !== "budget.exhausted") {
        target.durable.state.budget = (value as { ledger: RuntimeSession["durable"]["state"]["budget"] }).ledger;
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
    expect(target.durable.state.budget.reserved.inputTokens).toBe(98);
    expect(target.durable.state.budget.consumed.inputTokens).toBe(0);
    await Promise.all(accepted.map(async (id) => await budgets.release(target, id)));
    expect(target.durable.state.budget.reserved.inputTokens).toBe(0);
  });

  it("admits exactly maxDepth recursive child reservations and durably rejects the next", async () => {
    for (let initialDepth = 0; initialDepth <= 12; initialDepth += 1) {
      let target = session(`depth-${initialDepth}-0`);
      target.durable.state.budget = createBudgetLedger({ ...limits(), maxDepth: initialDepth });
      const exhausted: Array<{ dimension: string; requested: number; available: number }> = [];
      const budgets = new BudgetController(async (emittedSession, type, _authority, value) => {
        if (type === "budget.exhausted") {
          exhausted.push(value as { dimension: string; requested: number; available: number });
        } else if (typeof value === "object" && value !== null && "ledger" in value) {
          emittedSession.durable.state.budget = (value as { ledger: RuntimeSession["durable"]["state"]["budget"] }).ledger;
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
          children: target.durable.state.budget.limits.maxDepth - 1,
          maxDepth: target.durable.state.budget.limits.maxDepth - 1
        });
        expect(allocation.maxDepth).toBe(initialDepth - level - 1);
        target = session(`depth-${initialDepth}-${level + 1}`);
        target.durable.state.budget = createBudgetLedger(allocation);
      }

      await expect(control.reserveChildBudget(target, "too-deep", { maxDepth: 1 })).rejects.toMatchObject({
        code: "budget_exhausted",
        dimension: "maxDepth",
        requested: 1,
        available: 0
      });
      expect(exhausted).toEqual([{ dimension: "maxDepth", requested: 1, available: 0 }]);
      expect(target.durable.state.budget.reservations).toEqual([]);
      expect(target.durable.state.budget.reserved).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        modelTurns: 0,
        toolCalls: 0,
        children: 0
      });
    }
  });

  it("keeps randomized runtime frames bounded and progress checkpoints semantically non-terminating", () => {
    const next = random(0x56_38_70_72);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const target = session(`prompt-property-${iteration}`);
      const pathCount = Math.floor(next() * 20_000);
      target.durable.state.mutationFrontier = {
        revision: iteration,
        baselineManifestDigest: "a".repeat(64),
        currentStateDigest: createHash("sha256").update(`state-${iteration}`).digest("hex"),
        changedPaths: Array.from({ length: pathCount }, (_value, index) =>
          `generated/${iteration}/${index}/${"x".repeat(Math.floor(next() * 80))}.ts`),
        sourceCheckpointIds: []
      };
      const rounds = Math.floor(next() * 18);
      target.durable.state.messages.push({ role: "user", content: "property task" });
      for (let round = 0; round < rounds; round += 1) {
        const callId = `property-${iteration}-${round}`;
        const kind = Math.floor(next() * 4);
        const name = kind === 0 ? "read" : kind === 1 ? "edit" : kind === 2 ? "validate" : "update_plan";
        target.durable.state.messages.push({
          role: "assistant",
          content: "",
          toolCalls: [{ id: callId, name, arguments: {} }]
        });
        const receipt: ToolReceipt = {
          callId,
          ok: true,
          output: name,
          outcome: { status: "succeeded", output: name, diagnosticCodes: [] },
          observedEffects: name === "edit" ? ["filesystem.write"]
            : name === "validate" ? ["validation"] : ["filesystem.read"],
          actualEffects: name === "edit" ? ["filesystem.write"]
            : name === "validate" ? ["validation"] : ["filesystem.read"],
          ...(name === "edit"
            ? { workspaceDelta: { added: [], modified: [`file-${round}.ts`], deleted: [] } }
            : {}),
          artifacts: [],
          diagnostics: [],
          evidence: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        };
        target.durable.state.receipts.push(receipt);
      }
      const before = JSON.stringify(target.durable.state);
      progressCheckpoints(target);
      expect(JSON.stringify(target.durable.state)).toBe(before);
      expect(target.durable.state.outcome).toBeUndefined();
      expect(target.durable.state.proposedOutcome).toBeUndefined();

      const frame = materializeRuntimePromptFrame(target, {
        inputTokens: 50_000,
        outputTokens: 10_000,
        costMicroUsd: 1_000_000,
        modelTurns: 50,
        toolCalls: 100,
        children: 4
      }, {
        repository: [{
          id: "repository",
          authority: "runtime",
          provenance: "property repository",
          content: "r".repeat(Math.floor(next() * 40_000)),
          tokenCount: 10_000,
          priority: 1
        }],
        completion: evidenceLedger(target),
        plan: planLedger(target)
      });
      expect(frame.items.reduce((total, item) => total + item.tokenCount, 0)).toBeLessThanOrEqual(8_128);
    }
  }, 30_000);
});
