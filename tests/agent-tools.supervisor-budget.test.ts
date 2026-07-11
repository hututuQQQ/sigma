import { describe, expect, it, vi } from "vitest";
import type {
  BudgetLimits,
  PlanGraph,
  RuntimeControlPort,
  SupervisorPort,
  ToolExecutionContext
} from "../packages/agent-protocol/src/index.js";
import { EffectToolRegistry, registerSupervisorTools } from "../packages/agent-tools/src/index.js";

function plan(): PlanGraph {
  return {
    revision: 1,
    goal: "delegate safely",
    activeNodeId: "root",
    nodes: [{
      id: "root", title: "work", dependencies: [], status: "in_progress",
      owner: { kind: "root" }, acceptanceCriteria: ["done"], evidence: []
    }]
  };
}

function allocation(): BudgetLimits {
  return {
    inputTokens: 100, outputTokens: 100, costMicroUsd: 100, modelTurns: 10,
    toolCalls: 10, children: 1, maxDepth: 1
  };
}

function harness(reserve: RuntimeControlPort["reserveChildBudget"], spawn: SupervisorPort["spawnDurable"]) {
  let current = plan();
  const release = vi.fn(async () => undefined);
  const control = {
    readPlan: async () => structuredClone(current),
    updatePlan: async ({ expectedRevision, plan: next }) => {
      if (expectedRevision !== current.revision) throw new Error("revision conflict");
      current = structuredClone(next);
      return structuredClone(current);
    },
    reserveChildBudget: reserve,
    releaseChildBudget: release,
    rollbackChildPlanAssignment: async (childId: string, nodeIds: string[], previousPlan: PlanGraph) => {
      const selected = new Set(nodeIds);
      current = {
        ...current,
        revision: current.revision + 1,
        activeNodeId: previousPlan.activeNodeId,
        nodes: current.nodes.map((node) => selected.has(node.id)
          && node.owner.kind === "child" && node.owner.childId === childId
          ? structuredClone(previousPlan.nodes.find((item) => item.id === node.id) ?? node)
          : node)
      };
      return structuredClone(current);
    }
  } as unknown as RuntimeControlPort;
  const supervisor = {
    spawnDurable: spawn,
    followUp: () => undefined,
    join: async () => null,
    list: () => [],
    integrate: async () => null
  } satisfies SupervisorPort;
  const tools = registerSupervisorTools(new EffectToolRegistry(), supervisor);
  const context = {
    sessionId: "parent", runId: "run", workspacePath: process.cwd(), runMode: "analyze",
    signal: new AbortController().signal, heartbeat: () => undefined,
    progress: async () => undefined, createArtifact: async () => "artifact", runtimeControl: control
  } satisfies ToolExecutionContext;
  return { tools, context, release, current: () => current };
}

describe("spawn_agent budget and Plan transaction", () => {
  it("returns budget_exhausted before changing Plan or spawning", async () => {
    const spawn = vi.fn<SupervisorPort["spawnDurable"]>();
    const reserve = vi.fn<RuntimeControlPort["reserveChildBudget"]>(async () => {
      throw Object.assign(new Error("no budget"), { code: "budget_exhausted" });
    });
    const test = harness(reserve, spawn);
    await expect(test.tools.execute({
      callId: "spawn", name: "spawn_agent",
      arguments: { instruction: "inspect", planNodeIds: ["root"] }
    }, test.context)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(test.current()).toEqual(plan());
    expect(spawn).not.toHaveBeenCalled();
    expect(test.release).not.toHaveBeenCalled();
  });

  it("restores Plan ownership and releases the reservation when spawn fails", async () => {
    const reserve = vi.fn<RuntimeControlPort["reserveChildBudget"]>(async () => allocation());
    const spawn = vi.fn<SupervisorPort["spawnDurable"]>(async () => { throw new Error("spawn failed"); });
    const test = harness(reserve, spawn);
    await expect(test.tools.execute({
      callId: "spawn", name: "spawn_agent",
      arguments: { instruction: "inspect", planNodeIds: ["root"] }
    }, test.context)).rejects.toThrow("spawn failed");
    expect(test.current().nodes[0]?.owner).toEqual({ kind: "root" });
    expect(test.current().activeNodeId).toBe("root");
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("cannot steal a plan node from a child that is already running", async () => {
    const reserve = vi.fn<RuntimeControlPort["reserveChildBudget"]>(async () => allocation());
    const spawn = vi.fn<SupervisorPort["spawnDurable"]>(async ({ childId }) => ({ id: childId! }));
    const test = harness(reserve, spawn);
    await expect(test.tools.execute({
      callId: "first", name: "spawn_agent",
      arguments: { instruction: "inspect first", planNodeIds: ["root"] }
    }, test.context)).resolves.toMatchObject({ ok: true });
    const owner = test.current().nodes[0]!.owner;
    expect(owner.kind).toBe("child");

    await expect(test.tools.execute({
      callId: "second", name: "spawn_agent",
      arguments: { instruction: "inspect again", planNodeIds: ["root"] }
    }, test.context)).rejects.toMatchObject({ code: "plan_node_already_delegated" });
    expect(test.current().nodes[0]!.owner).toEqual(owner);
    expect(spawn).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
  });
});
