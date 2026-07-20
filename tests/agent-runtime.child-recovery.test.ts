import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager } from "../packages/agent-checkpoint/src/index.js";
import { createKernelState, rehydrate } from "../packages/agent-kernel/src/index.js";
import {
  createBudgetLedger,
  emptyBudgetAmounts,
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type BudgetLedgerState,
  type BudgetLimits,
  type ContextAuthority,
  type JsonValue,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import {
  createRuntime,
  createRuntimeSessionAggregate,
  reconcileInterruptedChildren
} from "../packages/agent-runtime/src/testing.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import { RuntimeEventLog } from "../packages/agent-runtime/src/runtime-event-log.js";
import type { RuntimeEventEmitter } from "../packages/agent-runtime/src/runtime-event-emitter.js";
import { restoreStoredSession } from "../packages/agent-runtime/src/restore-session.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { validationCoversDelta } from "../packages/agent-runtime/src/validation-policy.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { AgentSupervisor, type ChildSupervisorEvent, WorkspaceIsolationManager } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

class IdleGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "idle";
  readonly capabilities = {
    contextWindowTokens: 32_000, maxOutputTokens: 4_096, tools: true, parallelTools: true,
    reasoning: false, structuredOutput: false, promptCache: false, tokenizer: "approximate" as const
  };
  async complete(_request: ModelRequest): Promise<ModelResponse> { throw new Error("unused"); }
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("unused"));
  }
  async countTokens(): Promise<number> { return 1; }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function runtimeSessionFixture(
  state: ReturnType<typeof createKernelState>,
  workspacePath: string,
  seq = 0
): RuntimeSession {
  return createRuntimeSessionAggregate({
    sessionId: state.sessionId,
    runId: state.runId,
    modelTurn: 0,
    workspacePath,
    mode: state.mode,
    writeScope: [],
    strictWriteScope: false,
    gateway: new IdleGateway(),
    modelRole: "orchestrator",
    state,
    seq,
    controller: null,
    turnController: null,
    deadlineTimer: null,
    running: null,
    subscribers: new Set(),
    approvals: new Map(),
    callApprovals: new Map(),
    alwaysAllowedEffects: new Set(),
    processHandles: new Map(),
    steeringPending: 0,
    followUps: [],
    contextItems: [],
    loadedContextIds: new Set(),
    outcomeWaiters: [],
    idleWaiters: []
  });
}

async function append(
  store: SegmentedJsonlStore,
  sessionId: string,
  runId: string,
  seq: number,
  type: AgentEventType,
  payload: unknown,
  authority: Exclude<ContextAuthority, "external_verifier"> = "runtime"
): Promise<AgentEventEnvelope> {
  const event = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: randomUUID(),
    sessionId,
    runId,
    occurredAt: new Date(Date.now() + seq).toISOString(),
    type,
    authority,
    payload: json(payload)
  } as AgentEventEnvelope;
  await store.append(event as never, seq - 1);
  return event;
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

async function interruptedExclusiveWriter(root: string, store: SegmentedJsonlStore, mixed = false): Promise<{
  parentSessionId: string;
  childSessionId: string;
  childId: string;
  checkpointId: string;
  file: string;
  binary?: string;
}> {
  const runtime = createRuntime({
    gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root
  });
  const parent = await runtime.createSession({ workspacePath: root, mode: "change" });
  const child = await runtime.createChildSession(parent.sessionId, {
    workspacePath: root,
    mode: "change",
    writeScope: ["changed.ts", ...(mixed ? ["payload.bin"] : [])],
    strictWriteScope: true
  }, undefined, undefined, true);
  const childId = "77777777-7777-4777-8777-777777777777";
  await runtime.recordChildEvent(parent.sessionId, "child.spawned", {
    childId,
    payload: {
      detached: false,
      metadata: { mode: "change", planNodeIds: ["delegated"] }
    }
  });
  await runtime.recordChildEvent(parent.sessionId, "child.message", {
    childId,
    payload: { kind: "started", sessionId: child.sessionId }
  });
  const file = path.join(root, "changed.ts");
  await writeFile(file, "export const value = 1;\n", "utf8");
  const binary = mixed ? path.join(root, "payload.bin") : undefined;
  if (binary) await writeFile(binary, Buffer.from([0, 1, 2]));
  const checkpoints = new CheckpointManager({ rootDir: root });
  const checkpoint = await checkpoints.create({
    sessionId: child.sessionId,
    runId: child.runId,
    workspacePath: root,
    scopePaths: ["changed.ts", ...(mixed ? ["payload.bin"] : [])],
    baseSeq: 1
  });
  await writeFile(file, "export const value = 2;\n", "utf8");
  if (binary) await writeFile(binary, Buffer.from([0, 3, 4, 5]));
  await runtime.releaseSession(child.sessionId);
  await runtime.releaseSession(parent.sessionId);
  return {
    parentSessionId: parent.sessionId,
    childSessionId: child.sessionId,
    childId,
    checkpointId: checkpoint.checkpointId,
    file,
    ...(binary ? { binary } : {})
  };
}

async function sessionEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) events.push(event);
  return events;
}

describe("durable child identity and crash recovery", () => {
  it("releases an orphan child allocation and durably blocks its delegated Plan nodes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-orphan-child-reservation-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const sessionId = "orphan-parent";
    const runId = "orphan-run";
    const childId = "99999999-9999-4999-8999-999999999999";
    const state = createKernelState({
      sessionId,
      runId,
      mode: "change",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    state.plan = {
      revision: 1,
      goal: "recover orphan",
      nodes: [{
        id: "delegated", title: "delegated", dependencies: [], status: "in_progress",
        owner: { kind: "child", childId }, acceptanceCriteria: ["done"], evidence: []
      }]
    };
    const reservation = {
      reservationId: "orphan-reservation",
      ownerId: `child:${childId}`,
      status: "reserved" as const,
      requested: {
        inputTokens: 100, outputTokens: 50, costMicroUsd: 500, modelTurns: 10,
        toolCalls: 20, children: 3
      },
      consumed: emptyBudgetAmounts(),
      createdAt: new Date().toISOString()
    };
    state.budget.reservations.push(reservation);
    state.budget.reserved = { ...reservation.requested };
    const session = runtimeSessionFixture(state, root);
    const eventLog = new RuntimeEventLog(store);
    let crashAfterRelease = true;
    const emit: RuntimeEventEmitter = async (target, type, authority, payload) => {
      const event = await eventLog.emit(target, type, authority, payload);
      if (type === "budget.released" && crashAfterRelease) {
        crashAfterRelease = false;
        throw new Error("simulated crash after durable budget release");
      }
      return event;
    };
    const control = new RuntimeControlService({
      checkpoints: new CheckpointManager({ rootDir: root }),
      budgets: new BudgetController(emit),
      emit,
      createArtifact: async () => "artifact",
      readArtifact: async () => "artifact"
    });

    await expect(reconcileInterruptedChildren(store, session, control, emit))
      .rejects.toThrow("simulated crash after durable budget release");
    expect(session.durable.state.budget.reservations[0]?.status).toBe("released");
    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(1);
    expect(session.durable.state.budget.reserved).toEqual(emptyBudgetAmounts());
    expect(session.durable.state.budget.consumed).toEqual(emptyBudgetAmounts());
    expect(session.durable.state.budget.reservations[0]?.status).toBe("released");
    expect(session.durable.state.plan.nodes[0]).toMatchObject({
      status: "blocked",
      owner: { kind: "root" },
      blockedReason: `Child ${childId} failed.`
    });
    expect(session.durable.state.evidence).toContainEqual(expect.objectContaining({
      kind: "child_outcome",
      status: "failed",
      data: expect.objectContaining({ childId, planNodeIds: ["delegated"] })
    }));
    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(0);
    const events: AgentEventEnvelope[] = [];
    for await (const event of store.events(sessionId)) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "budget.released", "child.completed", "evidence.recorded", "plan.updated"
    ]);
  });

  it("publishes a durable terminal event when workspace allocation fails before launch", async () => {
    const events: ChildSupervisorEvent[] = [];
    const manager = {
      allocate: async () => { throw new Error("allocation failed"); }
    } as unknown as WorkspaceIsolationManager;
    const supervisor = new AgentSupervisor(async () => {
      throw new Error("factory must not run");
    }, 1, manager, async (event) => { events.push(event); });
    const child = await supervisor.spawnDurable({
      childId: "22222222-2222-4222-8222-222222222222",
      parentId: "parent",
      instruction: "inspect",
      workspacePath: process.cwd(),
      metadata: { planNodeIds: ["delegated"], budget: { inputTokens: 10 } }
    });
    await expect(supervisor.join(child.id)).resolves.toMatchObject({
      status: "failed", error: "allocation failed"
    });
    expect(events.map((event) => event.type)).toEqual(["child.spawned", "child.completed"]);
    expect(events[1]?.payload).toMatchObject({
      status: "failed",
      metadata: { planNodeIds: ["delegated"] },
      error: "allocation failed"
    });
  });

  it("restores custom root and child allocations after an early crash before the first snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-early-budget-recovery-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const rootLimits: BudgetLimits = {
      inputTokens: 12_345,
      outputTokens: 2_345,
      costMicroUsd: 98_765,
      modelTurns: 37,
      toolCalls: 73,
      children: 5,
      maxDepth: 4
    };
    const childLimits: BudgetLimits = {
      inputTokens: 1_234,
      outputTokens: 345,
      costMicroUsd: 8_765,
      modelTurns: 7,
      toolCalls: 13,
      children: 2,
      maxDepth: 2
    };
    const runtime = createRuntime({
      gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root,
      budgetLimits: rootLimits
    });
    const parent = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    const child = await runtime.createChildSession(parent.sessionId, {
      workspacePath: root, mode: "analyze"
    }, childLimits);

    const parentEvents = await sessionEvents(store, parent.sessionId);
    const childEvents = await sessionEvents(store, child.sessionId);
    expect(parentEvents.length).toBeLessThan(250);
    expect(childEvents.length).toBeLessThan(250);
    expect(await store.latestSnapshot(parent.sessionId)).toBeNull();
    expect(await store.latestSnapshot(child.sessionId)).toBeNull();
    expect(parentEvents[0]?.payload).toMatchObject({ budgetLimits: rootLimits });
    expect(childEvents[0]?.payload).toMatchObject({ budgetLimits: childLimits });
    expect(parentEvents[0]?.payload).not.toHaveProperty("ledger");
    expect(childEvents[0]?.payload).not.toHaveProperty("ledger");

    await runtime.releaseSession(child.sessionId);
    await runtime.releaseSession(parent.sessionId);
    const restoredParent = await restoreStoredSession(store, parent.sessionId, 60_000);
    const restoredChild = await restoreStoredSession(store, child.sessionId, 60_000);
    expect(restoredParent.state.budget.limits).toEqual(rootLimits);
    expect(restoredChild.state.budget.limits).toEqual(childLimits);
    expect(restoredChild.parentSessionId).toBe(parent.sessionId);
  });

  it("charges the complete parent reservation when a durable spawn has no durable started message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-pre-start-crash-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const sessionId = "pre-start-parent";
    const runId = "pre-start-run";
    const childId = "12121212-1212-4121-8121-121212121212";
    await append(store, sessionId, runId, 1, "child.spawned", {
      childId, payload: { detached: false, metadata: {} }
    });
    const state = createKernelState({
      sessionId, runId, mode: "change", startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    const requested = {
      inputTokens: 101, outputTokens: 51, costMicroUsd: 501, modelTurns: 3, toolCalls: 7, children: 2
    };
    state.budget.reserved = { ...requested };
    state.budget.reservations.push({
      reservationId: "pre-start-reservation",
      ownerId: `child:${childId}`,
      status: "reserved",
      requested,
      consumed: emptyBudgetAmounts(),
      createdAt: new Date().toISOString()
    });
    const session = runtimeSessionFixture(state, root, 1);
    const eventLog = new RuntimeEventLog(store);
    const emit: RuntimeEventEmitter = async (target, type, authority, payload) =>
      await eventLog.emit(target, type, authority, payload);
    const control = new RuntimeControlService({
      checkpoints: new CheckpointManager({ rootDir: root }),
      budgets: new BudgetController(emit),
      emit,
      createArtifact: async () => "artifact",
      readArtifact: async () => "artifact"
    });

    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(1);
    expect(session.durable.state.budget.consumed).toEqual(requested);
    expect(session.durable.state.budget.reservations[0]).toMatchObject({ status: "committed", consumed: requested });
  });

  it.each(["snapshot", "compact", "legacy"] as const)(
    "charges the complete parent reservation when the child %s ledger is semantically unreadable",
    async (corruption) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `sigma-child-${corruption}-budget-`));
      fixtures.push(root);
      const store = new SegmentedJsonlStore({ rootDir: root });
      const parentSessionId = `${corruption}-parent`;
      const parentRunId = `${corruption}-parent-run`;
      const childId = "34343434-3434-4343-8343-343434343434";
      const childSessionId = `${corruption}-child`;
      const childRunId = `${corruption}-child-run`;
      await append(store, parentSessionId, parentRunId, 1, "child.spawned", {
        childId, payload: { detached: false, metadata: {} }
      });
      await append(store, parentSessionId, parentRunId, 2, "child.message", {
        childId, payload: { kind: "started", sessionId: childSessionId }
      });
      const childLedger = createBudgetLedger();
      const created = await append(store, childSessionId, childRunId, 1, "session.created", {
        workspacePath: root,
        mode: "change",
        title: "child",
        writeScope: [],
        strictWriteScope: false,
        modelRole: "child_write",
        parentSessionId,
        budgetLimits: childLedger.limits
      });
      const childRequested = { ...emptyBudgetAmounts(), inputTokens: 11, toolCalls: 1 };
      const childReservation = {
        reservationId: "corrupt-child-reservation",
        ownerId: "model:corrupt-child",
        status: "reserved" as const,
        requested: childRequested,
        consumed: emptyBudgetAmounts(),
        createdAt: new Date().toISOString()
      };
      if (corruption === "snapshot") {
        const invalidSnapshotLedger = {
          ...childLedger,
          reservations: [childReservation]
        };
        await store.writeSnapshot({
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          storeLayoutVersion: STORE_LAYOUT_VERSION,
          sessionId: childSessionId,
          seq: 1,
          createdAt: new Date().toISOString(),
          state: json({ budget: invalidSnapshotLedger })
        });
      } else if (corruption === "compact") {
        await append(store, childSessionId, childRunId, 2, "budget.reserved", {
          reservationId: childReservation.reservationId,
          mutation: {
            schemaVersion: 1,
            kind: "reserve",
            reservation: childReservation,
            totals: { consumed: emptyBudgetAmounts(), reserved: emptyBudgetAmounts() }
          }
        });
      } else {
        await append(store, childSessionId, childRunId, 2, "budget.released", {
          reservationId: "missing",
          ledger: childLedger
        });
      }

      const state = createKernelState({
        sessionId: parentSessionId,
        runId: parentRunId,
        mode: "change",
        startedAt: created.occurredAt,
        deadlineAt: new Date(Date.now() + 60_000).toISOString()
      });
      const requested = {
        inputTokens: 103, outputTokens: 53, costMicroUsd: 503, modelTurns: 5, toolCalls: 9, children: 3
      };
      state.budget.reserved = { ...requested };
      state.budget.reservations.push({
        reservationId: `${corruption}-parent-reservation`,
        ownerId: `child:${childId}`,
        status: "reserved",
        requested,
        consumed: emptyBudgetAmounts(),
        createdAt: new Date().toISOString()
      });
      const session = runtimeSessionFixture(state, root, 2);
      const eventLog = new RuntimeEventLog(store);
      const emit: RuntimeEventEmitter = async (target, type, authority, payload) =>
        await eventLog.emit(target, type, authority, payload);
      const control = new RuntimeControlService({
        checkpoints: new CheckpointManager({ rootDir: root }),
        budgets: new BudgetController(emit),
        emit,
        createArtifact: async () => "artifact",
        readArtifact: async () => "artifact"
      });

      await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(1);
      expect(session.durable.state.budget.consumed).toEqual(requested);
      expect(session.durable.state.budget.reservations[0]).toMatchObject({ status: "committed", consumed: requested });
    }
  );

  it("rejects child budget increases both live and after replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-root-budget-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const options = {
      gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root
    };
    const first = createRuntime(options);
    const parent = await first.createSession({ workspacePath: root, mode: "analyze" });
    const child = await first.createChildSession(parent.sessionId, {
      workspacePath: root, mode: "analyze"
    }, undefined);

    await expect(first.command({
      type: "budget_increase", sessionId: parent.sessionId, increase: { modelTurns: 1 }
    })).resolves.toBeUndefined();
    await expect(first.command({
      type: "budget_increase", sessionId: child.sessionId, increase: { modelTurns: 1 }
    })).rejects.toMatchObject({ code: "budget_increase_root_only" });

    const created = [];
    for await (const event of store.events(child.sessionId)) {
      if (event.type === "session.created") created.push(event);
    }
    expect(created.at(-1)?.payload).toMatchObject({ parentSessionId: parent.sessionId });
    await first.releaseSession(child.sessionId);

    const resumed = createRuntime(options);
    await resumed.command({ type: "resume", sessionId: child.sessionId });
    await expect(resumed.command({
      type: "budget_increase", sessionId: child.sessionId, increase: { modelTurns: 1 }
    })).rejects.toMatchObject({ code: "budget_increase_root_only" });
  });

  it("settles an interrupted child once, charges its durable in-flight usage, and blocks its Plan node", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-crash-recovery-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const parentSessionId = "parent";
    const parentRunId = "parent-run";
    const childId = "11111111-1111-4111-8111-111111111111";
    const childSessionId = "child-session";
    await append(store, parentSessionId, parentRunId, 1, "child.spawned", {
      childId,
      payload: { detached: false, metadata: { planNodeIds: ["delegated"] } }
    });
    await append(store, parentSessionId, parentRunId, 2, "child.message", {
      childId, payload: { kind: "started", sessionId: childSessionId }
    });

    const childRunId = "child-run";
    const initialChildLedger = createBudgetLedger();
    const modelRequested = { ...emptyBudgetAmounts(), inputTokens: 111, toolCalls: 2 };
    const pendingRequested = { ...emptyBudgetAmounts(), inputTokens: 17, toolCalls: 1, children: 1 };
    const modelReservation = {
      reservationId: "child-model",
      ownerId: "model:child-request",
      status: "reserved" as const,
      requested: modelRequested,
      consumed: emptyBudgetAmounts(),
      createdAt: new Date(1_000).toISOString()
    };
    const pendingReservation = {
      reservationId: "child-tool",
      ownerId: "tool:child-call",
      status: "reserved" as const,
      requested: pendingRequested,
      consumed: emptyBudgetAmounts(),
      createdAt: new Date(4_000).toISOString()
    };
    const created = await append(store, childSessionId, childRunId, 1, "session.created", {
      workspacePath: root,
      mode: "change",
      title: "child",
      writeScope: [],
      strictWriteScope: false,
      modelRole: "child_write",
      parentSessionId,
      budgetLimits: initialChildLedger.limits
    });
    const modelReserved = await append(store, childSessionId, childRunId, 2, "budget.reserved", {
      reservationId: modelReservation.reservationId,
      mutation: {
        schemaVersion: 1,
        kind: "reserve",
        reservation: modelReservation,
        totals: { consumed: emptyBudgetAmounts(), reserved: modelRequested }
      }
    });
    const settledAt = new Date(3_000).toISOString();
    const modelCommitted = await append(store, childSessionId, childRunId, 3, "budget.committed", {
      reservationId: modelReservation.reservationId,
      mutation: {
        schemaVersion: 1,
        kind: "settle",
        reservationId: modelReservation.reservationId,
        status: "committed",
        consumed: modelRequested,
        settledAt,
        totals: { consumed: modelRequested, reserved: emptyBudgetAmounts() }
      }
    });
    const childState = createKernelState({
      sessionId: childSessionId,
      runId: childRunId,
      mode: "change",
      startedAt: created.occurredAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    const snapshotState = rehydrate(childState, [created, modelReserved, modelCommitted]);
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId: childSessionId,
      seq: 3,
      createdAt: new Date(3_500).toISOString(),
      state: json({ ...snapshotState, lastSeq: 3 })
    });
    await append(store, childSessionId, childRunId, 4, "budget.reserved", {
      reservationId: pendingReservation.reservationId,
      mutation: {
        schemaVersion: 1,
        kind: "reserve",
        reservation: pendingReservation,
        totals: { consumed: modelRequested, reserved: pendingRequested }
      }
    });
    await append(store, childSessionId, childRunId, 5, "run.completed", {
      kind: "completed", message: "child model run ended", evidence: []
    });

    const state = createKernelState({
      sessionId: parentSessionId,
      runId: parentRunId,
      mode: "change",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    state.plan = {
      revision: 2,
      goal: "recover child",
      nodes: [{
        id: "delegated", title: "delegated", dependencies: [], status: "in_progress",
        owner: { kind: "child", childId }, acceptanceCriteria: ["done"], evidence: []
      }]
    };
    const reservation = {
      reservationId: "parent-child-reservation",
      ownerId: `child:${childId}`,
      status: "reserved" as const,
      requested: {
        inputTokens: 100, outputTokens: 50, costMicroUsd: 500, modelTurns: 10,
        toolCalls: 20, children: 3
      },
      consumed: emptyBudgetAmounts(),
      createdAt: new Date().toISOString()
    };
    state.budget.reservations.push(reservation);
    state.budget.reserved = { ...reservation.requested };
    const session = runtimeSessionFixture(state, root);
    let seq = 2;
    const emit = async (
      target: RuntimeSession,
      type: AgentEventType,
      authority: Exclude<ContextAuthority, "external_verifier">,
      value: unknown
    ): Promise<AgentEventEnvelope> => {
      const event = await store.append({
        schemaVersion: EVENT_SCHEMA_VERSION,
        seq: ++seq,
        eventId: randomUUID(),
        sessionId: target.identity.sessionId,
        runId: target.durable.runId,
        occurredAt: new Date(Date.now() + seq).toISOString(),
        type,
        authority,
        payload: json(value)
      }, seq - 1);
      const payload = value as {
        ledger?: BudgetLedgerState;
        plan?: RuntimeSession["durable"]["state"]["plan"];
      };
      if (payload.ledger) target.durable.state.budget = structuredClone(payload.ledger);
      if (type === "plan.updated" && payload.plan) target.durable.state.plan = structuredClone(payload.plan);
      if (type === "evidence.recorded") target.durable.state.evidence.push(structuredClone(value) as never);
      return event;
    };
    const budgets = new BudgetController(emit);
    const control = new RuntimeControlService({
      checkpoints: new CheckpointManager({ rootDir: root }),
      budgets,
      emit,
      createArtifact: async () => "artifact"
    });

    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(1);
    expect(session.durable.state.budget.reserved).toMatchObject({ inputTokens: 0, toolCalls: 0, children: 0 });
    expect(session.durable.state.budget.consumed).toEqual({
      ...emptyBudgetAmounts(), inputTokens: 128, toolCalls: 3, children: 2
    });
    expect(session.durable.state.budget.reservations[0]?.status).toBe("committed");
    expect(session.durable.state.plan.nodes[0]).toMatchObject({
      status: "blocked",
      owner: { kind: "root" },
      blockedReason: `Child ${childId} failed.`
    });
    expect(session.durable.state.plan.nodes[0]?.evidence).toHaveLength(1);
    expect(session.durable.state.evidence[0]).toMatchObject({ kind: "child_outcome", status: "failed" });

    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(0);
    const childCompletions = [];
    for await (const event of store.events(parentSessionId)) {
      if (event.type === "child.completed") childCompletions.push(event);
    }
    expect(childCompletions).toHaveLength(1);
    expect(childCompletions[0]?.payload).toMatchObject({
      payload: {
        status: "failed",
        outcome: { code: "child_interrupted" },
        report: {
          recovery: "durable_no_replay",
          childTerminal: { status: "completed", outcome: { kind: "completed" } }
        }
      }
    });
  });

  it("finishes Plan derivation after child.completed was durable but its outcome evidence was interrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-partial-completion-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const sessionId = "partial-parent";
    const runId = "partial-run";
    const childId = "66666666-6666-4666-8666-666666666666";
    await append(store, sessionId, runId, 1, "child.spawned", {
      childId,
      payload: { detached: false, metadata: { planNodeIds: ["delegated"] } }
    });
    await append(store, sessionId, runId, 2, "child.completed", {
      childId,
      payload: {
        status: "completed",
        outcome: { kind: "completed", message: "done", evidence: [] },
        report: { budgetConsumed: {} },
        metadata: { planNodeIds: ["delegated"] },
        isolation: null,
        error: null
      }
    });

    const state = createKernelState({
      sessionId,
      runId,
      mode: "change",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    state.plan = {
      revision: 2,
      goal: "finish durable child",
      nodes: [{
        id: "delegated", title: "delegated", dependencies: [], status: "in_progress",
        owner: { kind: "child", childId }, acceptanceCriteria: ["done"], evidence: []
      }]
    };
    const session = runtimeSessionFixture(state, root, 2);
    const eventLog = new RuntimeEventLog(store);
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

    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(1);
    expect(session.durable.state.plan.nodes[0]).toMatchObject({
      status: "in_progress",
      owner: { kind: "root" },
      evidence: [expect.objectContaining({ kind: "child_outcome" })]
    });
    expect(session.durable.state.evidence).toContainEqual(expect.objectContaining({
      kind: "child_outcome",
      status: "passed",
      data: expect.objectContaining({ childId, outcome: "completed" })
    }));
    await expect(reconcileInterruptedChildren(store, session, control, emit)).resolves.toBe(0);
    const completions = [];
    for await (const event of store.events(sessionId)) {
      if (event.type === "child.completed") completions.push(event);
    }
    expect(completions).toHaveLength(1);
  });

  it("suspends a root for an interrupted exclusive-workspace child and imports kept mutation obligations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-workspace-keep-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const fixture = await interruptedExclusiveWriter(root, store, true);
    await new CheckpointManager({ rootDir: root }).seal(fixture.childSessionId, fixture.checkpointId);
    const runtime = createRuntime({
      gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root
    });

    await runtime.command({ type: "resume", sessionId: fixture.parentSessionId });
    await expect(runtime.waitForOutcome(fixture.parentSessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: `checkpoint:${fixture.checkpointId}`
    });
    const suspended = (await sessionEvents(store, fixture.parentSessionId))
      .filter((event) => event.type === "run.suspended");
    expect(suspended.at(-1)?.payload).toMatchObject({
      checkpointId: fixture.checkpointId,
      sourceSessionId: fixture.childSessionId,
      childId: fixture.childId,
      choices: ["restore", "keep"]
    });

    await runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.parentSessionId,
      checkpointId: fixture.checkpointId,
      decision: "keep"
    });
    expect(await readFile(fixture.file, "utf8")).toBe("export const value = 2;\n");
    const events = await sessionEvents(store, fixture.parentSessionId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "checkpoint.recovery_resolved",
      authority: "user",
      payload: expect.objectContaining({
        checkpointId: fixture.checkpointId,
        sourceSessionId: fixture.childSessionId,
        decision: "keep"
      })
    }));
    const importedDelta = events.find((event) => event.type === "evidence.recorded"
      && (event.payload as { kind?: unknown }).kind === "workspace_delta");
    expect(importedDelta?.payload).toMatchObject({
      sessionId: fixture.parentSessionId,
      kind: "workspace_delta",
      data: {
        checkpointId: fixture.checkpointId,
        sourceSessionId: fixture.childSessionId,
        childId: fixture.childId,
        reviewDiffPaths: ["changed.ts"],
        opaqueArtifacts: [expect.objectContaining({
          path: "payload.bin",
          before: expect.objectContaining({ sizeBytes: 3 }),
          after: expect.objectContaining({ sizeBytes: 4 })
        })]
      }
    });
    const importedValidation = events.find((event) => event.type === "evidence.recorded"
      && (event.payload as { kind?: unknown }).kind === "validation");
    expect(importedValidation?.payload).toMatchObject({
      kind: "validation",
      data: {
        validator: "checkpoint_postimage_integrity",
        frontierRevision: expect.any(Number),
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        coveredPaths: []
      }
    });
    expect(validationCoversDelta(
      importedValidation!.payload as ValidationEvidence,
      importedDelta!.payload as WorkspaceDeltaEvidence
    )).toBe(false);
    expect(events.some((event) => event.type === "review.completed")).toBe(false);

    await runtime.releaseSession(fixture.parentSessionId);
    const resumed = createRuntime({
      gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root
    });
    await resumed.command({ type: "resume", sessionId: fixture.parentSessionId });
    expect((await sessionEvents(store, fixture.parentSessionId))
      .filter((event) => event.type === "run.suspended")).toHaveLength(1);
    await resumed.releaseSession(fixture.parentSessionId);
  });

  it("restores an interrupted exclusive-workspace child checkpoint without importing its delta", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-workspace-restore-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const fixture = await interruptedExclusiveWriter(root, store);
    const runtime = createRuntime({
      gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root
    });

    await runtime.command({ type: "resume", sessionId: fixture.parentSessionId });
    await runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.parentSessionId,
      checkpointId: fixture.checkpointId,
      decision: "restore"
    });
    expect(await readFile(fixture.file, "utf8")).toBe("export const value = 1;\n");
    const events = await sessionEvents(store, fixture.parentSessionId);
    expect(events.some((event) => event.type === "evidence.recorded"
      && (event.payload as { kind?: unknown }).kind === "workspace_delta")).toBe(false);
    expect((await new CheckpointManager({ rootDir: root }).list(fixture.childSessionId)).at(-1)?.status)
      .toBe("restored");
    await runtime.releaseSession(fixture.parentSessionId);
  });

  it("replays a durable user keep decision after a crash before checkpoint application", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-workspace-decision-replay-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const fixture = await interruptedExclusiveWriter(root, store);
    const prior = await sessionEvents(store, fixture.parentSessionId);
    let seq = prior.at(-1)?.seq ?? 0;
    const runId = prior.at(-1)!.runId;
    await append(store, fixture.parentSessionId, runId, ++seq, "checkpoint.recovery_resolved", {
      checkpointId: fixture.checkpointId,
      sourceSessionId: fixture.childSessionId,
      childId: fixture.childId,
      decision: "keep"
    }, "user");
    await append(store, fixture.parentSessionId, runId, seq + 1, "run.suspended", {
      requestId: `checkpoint:${fixture.checkpointId}`,
      checkpointId: fixture.checkpointId,
      choices: ["restore", "keep"],
      message: "simulated crash after durable user decision"
    });
    const runtime = createRuntime({
      gateway: new IdleGateway(), tools: new EffectToolRegistry(), store, storeRootDir: root
    });

    await runtime.command({ type: "resume", sessionId: fixture.parentSessionId });
    expect(await readFile(fixture.file, "utf8")).toBe("export const value = 2;\n");
    const events = await sessionEvents(store, fixture.parentSessionId);
    expect(events.filter((event) => event.type === "run.suspended")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "evidence.recorded",
      payload: expect.objectContaining({
        kind: "workspace_delta",
        data: expect.objectContaining({ sourceSessionId: fixture.childSessionId })
      })
    }));
    expect((await new CheckpointManager({ rootDir: root }).list(fixture.childSessionId)).at(-1)?.status)
      .toBe("sealed");
    await runtime.releaseSession(fixture.parentSessionId);
  });
});
