import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointManager,
  type CheckpointRecord,
  type CheckpointRestoreFaultEvent
} from "../packages/agent-checkpoint/src/index.js";
import type {
  AgentEventEnvelope,
  AgentEventType,
  JsonValue,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { EVENT_SCHEMA_VERSION } from "../packages/agent-protocol/src/index.js";
import {
  createRuntime,
  restoreStoredSession,
  type InProcessRuntimeClient
} from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

class UnusedGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "unused";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Checkpoint recovery must not invoke the model.");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("Checkpoint recovery must not invoke the model."));
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

function checkpointPayload(record: CheckpointRecord): JsonValue {
  return {
    checkpointId: record.checkpointId,
    sessionId: record.sessionId,
    runId: record.runId,
    status: record.status,
    createdAt: record.createdAt,
    preManifestDigest: record.preManifestDigest
  };
}

function event(
  sessionId: string,
  runId: string,
  seq: number,
  type: AgentEventType,
  payload: JsonValue
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: randomUUID(),
    sessionId,
    runId,
    occurredAt: new Date(Date.now() + seq).toISOString(),
    type,
    authority: "runtime",
    payload
  };
}

interface RecoveryFixture {
  workspace: string;
  store: SegmentedJsonlStore;
  runtime: InProcessRuntimeClient;
  manager: CheckpointManager;
  checkpoint: CheckpointRecord;
}

async function recoveryFixture(
  hasActiveChildren?: () => boolean,
  restoreFaultInjector?: (event: CheckpointRestoreFaultEvent) => void | Promise<void>
): Promise<RecoveryFixture> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-checkpoint-recovery-"));
  const storeRootDir = path.join(workspace, ".agent");
  const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  await writeFile(path.join(workspace, "target.txt"), "before", "utf8");
  const manager = new CheckpointManager({ rootDir: storeRootDir });
  const checkpoint = await manager.create({
    sessionId,
    runId,
    workspacePath: workspace,
    scopePaths: ["target.txt"],
    baseSeq: 2
  });
  const events = [
    event(sessionId, runId, 1, "session.created", { workspacePath: workspace, mode: "change" }),
    event(sessionId, runId, 2, "run.started", {
      mode: "change",
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    }),
    event(sessionId, runId, 3, "checkpoint.created", checkpointPayload(checkpoint))
  ];
  for (const stored of events) await store.append(stored, stored.seq - 1);
  await writeFile(path.join(workspace, "target.txt"), "partial mutation", "utf8");
  const runtime = createRuntime({
    gateway: new UnusedGateway(),
    store,
    storeRootDir,
    tools: registerBuiltinTools(new EffectToolRegistry()),
    permissionMode: "auto",
    runDeadlineMs: 60_000,
    ...(hasActiveChildren ? { hasActiveChildren: () => hasActiveChildren() } : {}),
    ...(restoreFaultInjector ? { checkpointRestoreFaultInjector: restoreFaultInjector } : {})
  });
  return { workspace, store, runtime, manager, checkpoint };
}

async function storedEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const stored of store.events(sessionId)) events.push(stored);
  return events;
}

describe("runtime checkpoint recovery control plane", () => {
  it("does not expose undo or interrupted-checkpoint resolution as model tools", () => {
    const names = registerBuiltinTools(new EffectToolRegistry()).descriptors().map((item) => item.name);
    expect(names).not.toContain("undo_checkpoint");
    expect(names).not.toContain("checkpoint_recovery");
    expect(names).not.toContain("restore_checkpoint");
  });

  it("reconciles a crash after the checkpoint record sealed but before its durable event", async () => {
    const fixture = await recoveryFixture();
    const inspection = await fixture.manager.inspectOpen(
      fixture.checkpoint.sessionId,
      fixture.checkpoint.checkpointId
    );
    await fixture.manager.seal(
      fixture.checkpoint.sessionId,
      fixture.checkpoint.checkpointId,
      inspection.currentManifestDigest
    );
    await fixture.runtime.command({ type: "resume", sessionId: fixture.checkpoint.sessionId });
    const events = await storedEvents(fixture.store, fixture.checkpoint.sessionId);
    expect(events.filter((item) => item.type === "checkpoint.sealed")).toHaveLength(1);
    expect(events.some((item) => item.type === "run.suspended")).toBe(false);
  });

  it("reconciles a crash after sealed undo restored the workspace but before its durable event", async () => {
    const fixture = await recoveryFixture();
    const sessionId = fixture.checkpoint.sessionId;
    await fixture.runtime.command({ type: "resume", sessionId });
    await fixture.runtime.command({
      type: "checkpoint_recovery",
      sessionId,
      checkpointId: fixture.checkpoint.checkpointId,
      decision: "keep"
    });
    const beforeCrash = await restoreStoredSession(fixture.store, sessionId, 60_000);
    expect(beforeCrash.state.mutationEvidence).toContainEqual(expect.objectContaining({
      kind: "workspace_delta",
      data: expect.objectContaining({ checkpointId: fixture.checkpoint.checkpointId })
    }));
    await fixture.runtime.releaseSession(sessionId);

    await fixture.manager.undoLatest(sessionId);
    await expect(readFile(path.join(fixture.workspace, "target.txt"), "utf8")).resolves.toBe("before");
    expect((await storedEvents(fixture.store, sessionId)).some((item) => item.type === "checkpoint.restored"))
      .toBe(false);

    const resumed = createRuntime({
      gateway: new UnusedGateway(),
      store: fixture.store,
      storeRootDir: path.join(fixture.workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    await resumed.command({ type: "resume", sessionId });
    let events = await storedEvents(fixture.store, sessionId);
    expect(events.filter((item) => item.type === "checkpoint.restored")).toEqual([
      expect.objectContaining({ authority: "runtime" })
    ]);
    let restored = await restoreStoredSession(fixture.store, sessionId, 60_000);
    expect(restored.state.checkpointHead).toMatchObject({
      checkpointId: fixture.checkpoint.checkpointId,
      status: "restored"
    });
    expect(restored.state.mutationEvidence.some((item) => item.kind === "workspace_delta"
      && item.data.checkpointId === fixture.checkpoint.checkpointId)).toBe(false);

    await resumed.releaseSession(sessionId);
    const resumedAgain = createRuntime({
      gateway: new UnusedGateway(),
      store: fixture.store,
      storeRootDir: path.join(fixture.workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    await resumedAgain.command({ type: "resume", sessionId });
    events = await storedEvents(fixture.store, sessionId);
    expect(events.filter((item) => item.type === "checkpoint.restored")).toHaveLength(1);
    restored = await restoreStoredSession(fixture.store, sessionId, 60_000);
    expect(restored.state.mutationEvidence.some((item) => item.kind === "workspace_delta"
      && item.data.checkpointId === fixture.checkpoint.checkpointId)).toBe(false);
  });

  it("blocks normal commands, rejects stale recovery postimages, and safely restores on a fresh user decision", async () => {
    const fixture = await recoveryFixture();
    await fixture.runtime.command({ type: "resume", sessionId: fixture.checkpoint.sessionId });
    await expect(fixture.runtime.waitForOutcome(fixture.checkpoint.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: `checkpoint:${fixture.checkpoint.checkpointId}`
    });
    await expect(fixture.runtime.command({
      type: "submit",
      sessionId: fixture.checkpoint.sessionId,
      text: "continue anyway"
    })).rejects.toMatchObject({ code: "checkpoint_recovery_required" });

    await writeFile(path.join(fixture.workspace, "target.txt"), "edit after prompt", "utf8");
    await expect(fixture.runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.checkpoint.sessionId,
      checkpointId: fixture.checkpoint.checkpointId,
      decision: "restore"
    })).rejects.toMatchObject({ code: "checkpoint_conflict" });
    await expect(readFile(path.join(fixture.workspace, "target.txt"), "utf8")).resolves.toBe("edit after prompt");

    await fixture.runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.checkpoint.sessionId,
      checkpointId: fixture.checkpoint.checkpointId,
      decision: "restore"
    });
    await expect(readFile(path.join(fixture.workspace, "target.txt"), "utf8")).resolves.toBe("before");
    const events = await storedEvents(fixture.store, fixture.checkpoint.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "checkpoint.restored",
      authority: "user"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "checkpoint.recovery_resolved",
      authority: "user",
      payload: { checkpointId: fixture.checkpoint.checkpointId, decision: "restore" }
    }));
  });

  it("keeps an open delta only by user choice and blocks undo for active children and concurrent callers", async () => {
    let childActive = false;
    const fixture = await recoveryFixture(() => childActive);
    await fixture.runtime.command({ type: "resume", sessionId: fixture.checkpoint.sessionId });
    await fixture.runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.checkpoint.sessionId,
      checkpointId: fixture.checkpoint.checkpointId,
      decision: "keep"
    });
    await expect(readFile(path.join(fixture.workspace, "target.txt"), "utf8")).resolves.toBe("partial mutation");
    childActive = true;
    await expect(fixture.runtime.undoLatestCheckpoint(fixture.checkpoint.sessionId))
      .rejects.toMatchObject({ code: "checkpoint_children_active" });

    childActive = false;
    const attempts = await Promise.allSettled([
      fixture.runtime.undoLatestCheckpoint(fixture.checkpoint.sessionId),
      fixture.runtime.undoLatestCheckpoint(fixture.checkpoint.sessionId)
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "checkpoint_busy" }
    });
    await expect(readFile(path.join(fixture.workspace, "target.txt"), "utf8")).resolves.toBe("before");
    const events = await storedEvents(fixture.store, fixture.checkpoint.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "checkpoint.recovery_resolved",
      authority: "user",
      payload: { checkpointId: fixture.checkpoint.checkpointId, decision: "keep" }
    }));
  });

  it("keeps NeedsInput and emits no restored event when transactional rollback cannot complete", async () => {
    const fixture = await recoveryFixture(undefined, ({ point }) => {
      if (point === "after_install") throw new Error("injected restore failure");
      if (point === "before_rollback_restore") throw new Error("injected rollback failure");
    });
    await fixture.runtime.command({ type: "resume", sessionId: fixture.checkpoint.sessionId });
    await expect(fixture.runtime.waitForOutcome(fixture.checkpoint.sessionId)).resolves.toMatchObject({
      kind: "needs_input"
    });

    await expect(fixture.runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.checkpoint.sessionId,
      checkpointId: fixture.checkpoint.checkpointId,
      decision: "restore"
    })).rejects.toMatchObject({ code: "checkpoint_recovery_failed" });
    await expect(fixture.runtime.waitForOutcome(fixture.checkpoint.sessionId)).resolves.toMatchObject({
      kind: "needs_input"
    });
    await expect(fixture.runtime.command({
      type: "submit",
      sessionId: fixture.checkpoint.sessionId,
      text: "continue"
    })).rejects.toMatchObject({ code: "checkpoint_recovery_required" });
    const records = await fixture.manager.list(fixture.checkpoint.sessionId);
    expect(records).toContainEqual(expect.objectContaining({ status: "open" }));
    const events = await storedEvents(fixture.store, fixture.checkpoint.sessionId);
    expect(events.some((event) => event.type === "checkpoint.restored")).toBe(false);
    expect(events.some((event) => event.type === "checkpoint.recovery_resolved")).toBe(false);
  });
});
