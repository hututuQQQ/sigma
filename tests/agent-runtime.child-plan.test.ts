import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager } from "../packages/agent-checkpoint/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import type { JsonValue, PlanGraph } from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import { handleChildEvent } from "../packages/agent-runtime/src/child-event-handler.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import { RuntimeEventLog } from "../packages/agent-runtime/src/runtime-event-log.js";
import type { RuntimeEventEmitter } from "../packages/agent-runtime/src/runtime-event-emitter.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function childNode(id: string, childId: string): PlanGraph["nodes"][number] {
  return {
    id,
    title: id,
    dependencies: [],
    status: "in_progress",
    owner: { kind: "child", childId },
    acceptanceCriteria: [`${id} is complete`],
    evidence: []
  };
}

async function harness(nodes: PlanGraph["nodes"]): Promise<{
  session: RuntimeSession;
  control: RuntimeControlService;
  emit: RuntimeEventEmitter;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-plan-"));
  fixtures.push(root);
  const state = createKernelState({
    sessionId: "parent",
    runId: "parent-run",
    mode: "change",
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  });
  state.plan = { revision: 1, goal: "delegate", nodes };
  const session = {
    sessionId: state.sessionId,
    runId: state.runId,
    state,
    seq: 0,
    workspacePath: root,
    subscribers: new Set()
  } as unknown as RuntimeSession;
  const eventLog = new RuntimeEventLog(new SegmentedJsonlStore({ rootDir: root }));
  const emit: RuntimeEventEmitter = async (target, type, authority, payload) =>
    await eventLog.emit(target, type, authority, payload);
  const budgets = new BudgetController(emit);
  const control = new RuntimeControlService({
    checkpoints: new CheckpointManager({ rootDir: root }),
    budgets,
    emit,
    createArtifact: async () => "artifact",
    readArtifact: async () => "artifact"
  });
  return { session, control, emit };
}

function completion(childId: string, planNodeIds: string[]): JsonValue {
  return json({
    childId,
    payload: {
      status: "completed",
      outcome: { kind: "completed", message: "done", evidence: [] },
      report: { budgetConsumed: {} },
      metadata: { planNodeIds }
    }
  });
}

function failure(childId: string, planNodeIds: string[]): JsonValue {
  return json({
    childId,
    payload: {
      status: "failed",
      outcome: { kind: "recoverable_failure", code: "child_failed", message: "failed" },
      report: { budgetConsumed: {} },
      metadata: { planNodeIds }
    }
  });
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("child Plan terminal ownership", () => {
  it("returns a successful child node to root with evidence so root can complete it", async () => {
    const childId = "11111111-1111-4111-8111-111111111111";
    const fixture = await harness([childNode("implementation", childId)]);
    await handleChildEvent(fixture.session, "child.completed", completion(childId, ["implementation"]),
      fixture.control, fixture.emit);

    const returned = fixture.session.state.plan.nodes[0]!;
    expect(returned).toMatchObject({ status: "in_progress", owner: { kind: "root" } });
    expect(returned.evidence).toHaveLength(1);

    const current = fixture.session.state.plan;
    await expect(fixture.control.updatePlan(fixture.session, {
      expectedRevision: current.revision,
      plan: {
        ...current,
        revision: current.revision + 1,
        nodes: [{ ...returned, status: "completed" }]
      }
    })).resolves.toMatchObject({ nodes: [{ status: "completed", owner: { kind: "root" } }] });
  });

  it("returns a failed child node blocked, then permits root to reopen and re-delegate it", async () => {
    const childId = "22222222-2222-4222-8222-222222222222";
    const replacementId = "33333333-3333-4333-8333-333333333333";
    const fixture = await harness([childNode("validation", childId)]);
    await handleChildEvent(fixture.session, "child.completed", failure(childId, ["validation"]),
      fixture.control, fixture.emit);

    const blocked = fixture.session.state.plan;
    expect(blocked.nodes[0]).toMatchObject({
      status: "blocked",
      owner: { kind: "root" },
      blockedReason: `Child ${childId} failed.`
    });
    await fixture.control.updatePlan(fixture.session, {
      expectedRevision: blocked.revision,
      plan: {
        ...blocked,
        revision: blocked.revision + 1,
        activeNodeId: "validation",
        nodes: [{
          ...blocked.nodes[0]!,
          status: "in_progress",
          blockedReason: undefined,
          evidence: []
        }]
      }
    });
    const reopened = fixture.session.state.plan;
    await expect(fixture.control.updatePlan(fixture.session, {
      expectedRevision: reopened.revision,
      plan: {
        ...reopened,
        revision: reopened.revision + 1,
        activeNodeId: undefined,
        nodes: [{ ...reopened.nodes[0]!, owner: { kind: "child", childId: replacementId } }]
      }
    })).resolves.toMatchObject({
      nodes: [{ status: "in_progress", owner: { kind: "child", childId: replacementId } }]
    });
    await handleChildEvent(fixture.session, "child.completed", completion(replacementId, ["validation"]),
      fixture.control, fixture.emit);
    const returned = fixture.session.state.plan;
    await expect(fixture.control.updatePlan(fixture.session, {
      expectedRevision: returned.revision,
      plan: {
        ...returned,
        revision: returned.revision + 1,
        nodes: [{ ...returned.nodes[0]!, status: "completed" }]
      }
    })).resolves.toMatchObject({ nodes: [{ status: "completed", owner: { kind: "root" } }] });
  });

  it("serializes concurrent child completions without a Plan revision conflict", async () => {
    const first = "44444444-4444-4444-8444-444444444444";
    const second = "55555555-5555-4555-8555-555555555555";
    const fixture = await harness([childNode("first", first), childNode("second", second)]);

    await expect(Promise.all([
      handleChildEvent(fixture.session, "child.completed", completion(first, ["first"]), fixture.control, fixture.emit),
      handleChildEvent(fixture.session, "child.completed", completion(second, ["second"]), fixture.control, fixture.emit)
    ])).resolves.toHaveLength(2);

    expect(fixture.session.state.plan.revision).toBe(3);
    expect(fixture.session.state.plan.nodes).toMatchObject([
      { id: "first", status: "in_progress", owner: { kind: "root" }, evidence: [expect.any(Object)] },
      { id: "second", status: "in_progress", owner: { kind: "root" }, evidence: [expect.any(Object)] }
    ]);
  });
});
