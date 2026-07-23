import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  isCompletionReferenceableEvidence,
  type JsonValue,
  type ToolDescriptor,
  type ValidationEvidence
} from "../packages/agent-protocol/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import {
  SegmentedJsonlStore,
  sessionDirectory,
  snapshotName
} from "../packages/agent-store/src/index.js";
import { restoreStoredSession } from "../packages/agent-runtime/src/restore-session.js";
import { armRunDeadline } from "../packages/agent-runtime/src/run-deadline.js";
import { ordinaryToolFailureReceipt } from "../packages/agent-runtime/src/tool-failure-receipt.js";
import { resolveToolIdleWatchdogMs } from "../packages/agent-runtime/src/tool-execution-monitor.js";
import type { RuntimeOptions } from "../packages/agent-runtime/src/types.js";
import { completeAgentEventPayload } from "./testkit/agent-event-fixtures.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function descriptor(idleTimeoutMs?: number): ToolDescriptor {
  return {
    name: "foreground",
    description: "fixture",
    inputSchema: { type: "object" },
    possibleEffects: ["process.spawn.readonly"],
    executionMode: "exclusive",
    resourceKeys: [],
    approval: "auto",
    idempotent: false,
    timeoutMs: 600_000,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })
  };
}

function runtime(toolIdleWatchdogMs?: number | false): RuntimeOptions {
  return {
    ...(toolIdleWatchdogMs === undefined ? {} : { toolIdleWatchdogMs })
  } as RuntimeOptions;
}

async function writeLegacyV5Snapshot(input: {
  rootDir: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: Record<string, JsonValue>;
  envelopeSchemaVersion?: 5 | 6;
}): Promise<void> {
  const snapshot = {
    schemaVersion: input.envelopeSchemaVersion ?? 5,
    storeLayoutVersion: STORE_LAYOUT_VERSION,
    sessionId: input.sessionId,
    seq: input.seq,
    createdAt: input.createdAt,
    state: input.state
  };
  const checksum = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const directory = path.join(sessionDirectory(input.rootDir, input.sessionId), "snapshots");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, snapshotName(input.seq)),
    JSON.stringify({ checksum, snapshot }),
    "utf8"
  );
}

describe("runtime recovery convergence", () => {
  it("returns every capability failure as an ordinary receipt without retry state", () => {
    const session = runtimeSessionFixture();
    const signal = new AbortController().signal;
    const failure = Object.assign(new Error("runtime unavailable"), { code: "toolchain_unavailable" });
    const first = { id: "first", name: "exec", arguments: { executable: "node", args: ["--version"] } };
    const different = { id: "different", name: "exec", arguments: { executable: "pnpm", args: ["test"] } };
    expect(ordinaryToolFailureReceipt(
      first, "2026-01-01T00:00:00.000Z", failure, signal
    ).diagnostics).toContain("toolchain_unavailable");
    expect(ordinaryToolFailureReceipt(
      different, "2026-01-01T00:00:00.000Z", failure, signal
    ).diagnostics).toContain("toolchain_unavailable");
    expect(ordinaryToolFailureReceipt(
      { ...first, id: "retry" }, "2026-01-01T00:00:00.000Z", failure, signal
    ).diagnostics).toContain("toolchain_unavailable");
    expect(session.interaction).not.toHaveProperty("capabilityFailures");
  });

  it("keeps the outer idle watchdog behind a tool-owned idle deadline and allows an explicit policy", () => {
    expect(resolveToolIdleWatchdogMs(runtime(), descriptor(120_000))).toBe(150_000);
    expect(resolveToolIdleWatchdogMs(runtime(), descriptor())).toBeUndefined();
    expect(resolveToolIdleWatchdogMs(runtime(false), descriptor(120_000))).toBeUndefined();
    expect(resolveToolIdleWatchdogMs(runtime(240_000), descriptor(120_000))).toBe(240_000);
    expect(() => resolveToolIdleWatchdogMs(runtime(0), descriptor(120_000))).toThrow("positive integer");
  });

  it("assigns one stable code to the durable run deadline abort reason", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
      const controller = new AbortController();
      const session = runtimeSessionFixture({ execution: { controller } });
      session.durable.state.deadlineAt = "2026-07-12T00:00:00.010Z";
      armRunDeadline(session);
      await vi.advanceTimersByTimeAsync(11);
      expect(controller.signal.reason).toMatchObject({
        name: "TimeoutError",
        code: "run_deadline"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("migrates the published V5 task authorities and strips every legacy field", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "sigma-semantic-restore-"));
    const storeRootDir = path.join(workspacePath, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const sessionId = "legacy-semantic-session";
    const runId = "legacy-semantic-run";
    const startedAt = "2026-07-12T00:00:00.000Z";
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: 1,
      eventId: "legacy-created",
      sessionId,
      runId,
      occurredAt: startedAt,
      type: "session.created",
      authority: "runtime",
      payload: completeAgentEventPayload("session.created", { workspacePath, mode: "change" })
    }, 0);
    const current = createKernelState({
      sessionId,
      runId,
      mode: "change",
      startedAt,
      deadlineAt: "2026-07-12T00:15:00.000Z"
    });
    const oldSnapshot = JSON.parse(JSON.stringify({ ...current, lastSeq: 1 })) as Record<string, JsonValue>;
    Object.assign(oldSnapshot, {
      schemaVersion: 5,
      taskControl: {
        schemaVersion: 1,
        goalEpoch: 3,
        goalEpochSource: "submit",
        phase: "repair_only",
        semanticFacts: { entries: [] },
        episode: {
          basisDigest: "b".repeat(64),
          startedRevision: 1,
          noProgressBatches: 6,
          observations: 7
        },
        obligation: {
          kind: "terminal_resolution",
          stage: "report",
          basisDigest: "c".repeat(64),
          openedRevision: 1,
          attempts: 2,
          failureCode: "legacy_no_progress"
        },
        completionCandidate: {
          answer: "Preserved draft.",
          digest: "d".repeat(64)
        },
        modelContinuationAttempts: 4
      },
      completionRepairAttempts: 0,
      continuationAttempts: 0,
      repeatedToolBatchCount: 0,
      receiptCountAtLastUserInput: 0,
      semanticProgress: { workspaceChanges: 0, durableEvidence: 0, revision: 0 }
    });
    await writeLegacyV5Snapshot({
      rootDir: storeRootDir,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: oldSnapshot
    });

    const restored = await restoreStoredSession(store, sessionId, 60_000);
    expect(restored.state.schemaVersion).toBe(7);
    expect(restored.state).not.toHaveProperty("taskControl");
    expect(restored.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Preserved draft."
    });
    for (const key of [
      "completionRepairAttempts", "completionRepair", "continuationAttempts",
      "repeatedToolBatchCount", "receiptCountAtLastUserInput", "semanticProgress",
      "semanticFailureCluster", "lastToolBatchSignature", "lastToolBatchOutcomeSignature"
    ]) expect(restored.state).not.toHaveProperty(key);
    await expect(store.latestSnapshot(sessionId)).resolves.toMatchObject({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state: { schemaVersion: 7 }
    });
  });

  it("migrates a published V6 snapshot into the V7 truncation state", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "sigma-v6-restore-"));
    const storeRootDir = path.join(workspacePath, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const sessionId = "legacy-v6-session";
    const runId = "legacy-v6-run";
    const startedAt = "2026-07-12T00:00:00.000Z";
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: 1,
      eventId: "v6-created",
      sessionId,
      runId,
      occurredAt: startedAt,
      type: "session.created",
      authority: "runtime",
      payload: completeAgentEventPayload("session.created", {
        workspacePath,
        mode: "change"
      })
    }, 0);
    const raw = JSON.parse(JSON.stringify(createKernelState({
      sessionId,
      runId,
      mode: "change",
      startedAt,
      deadlineAt: "2026-07-12T00:15:00.000Z"
    }))) as Record<string, JsonValue>;
    raw.schemaVersion = 6;
    delete raw.lastModelFinishReason;
    delete raw.consecutiveLengthFinishes;
    delete raw.consecutiveLengthNoAction;
    delete raw.lastModelHadToolCalls;
    await writeLegacyV5Snapshot({
      rootDir: storeRootDir,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: raw,
      envelopeSchemaVersion: 6
    });

    const restored = await restoreStoredSession(store, sessionId, 60_000);
    expect(restored.state).toMatchObject({
      schemaVersion: 7,
      consecutiveLengthFinishes: 0,
      consecutiveLengthNoAction: 0,
      lastModelHadToolCalls: false
    });
    await expect(store.latestSnapshot(sessionId)).resolves.toMatchObject({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state: { schemaVersion: 7 }
    });
  });

  it("preserves failed validation status, scope, and execution claim across snapshot restore", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "sigma-validation-restore-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspacePath, ".agent") });
    const sessionId = "validation-session";
    const runId = "validation-run";
    const startedAt = "2026-07-12T00:00:00.000Z";
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: 1,
      eventId: "validation-created",
      sessionId,
      runId,
      occurredAt: startedAt,
      type: "session.created",
      authority: "runtime",
      payload: completeAgentEventPayload("session.created", { workspacePath, mode: "change" })
    }, 0);
    const current = createKernelState({
      sessionId,
      runId,
      mode: "change",
      startedAt,
      deadlineAt: "2026-07-12T00:15:00.000Z"
    });
    const failed: ValidationEvidence = {
      evidenceId: "failed-validation",
      sessionId,
      runId,
      kind: "validation",
      status: "failed",
      createdAt: startedAt,
      producer: { authority: "tool", id: "validate" },
      summary: "tests exited 1",
      data: {
        validator: "command",
        command: "pnpm test",
        exitCode: 1,
        termination: {
          processStarted: true,
          state: "exited",
          exitCode: 1,
          signal: null,
          timedOut: false,
          idleTimedOut: false,
          cancelled: false
        },
        artifactIds: ["stderr"],
        frontierRevision: 0,
        stateDigest: "0".repeat(64),
        coveredPaths: ["delta"]
      }
    };
    current.evidence = [failed];
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: { ...current, lastSeq: 1 }
    });

    const restored = await restoreStoredSession(store, sessionId, 60_000);
    expect(restored.state.evidence).toEqual([failed]);
    expect(isCompletionReferenceableEvidence(restored.state.evidence[0]!, sessionId, runId)).toBe(true);
  });

  it("restores the exact durable context archive and covered-prefix digest", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "sigma-context-archive-restore-"));
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspacePath, ".agent") });
    const sessionId = "context-archive-session";
    const runId = "context-archive-run";
    const startedAt = "2026-07-12T00:00:00.000Z";
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: 1,
      eventId: "context-archive-created",
      sessionId,
      runId,
      occurredAt: startedAt,
      type: "session.created",
      authority: "runtime",
      payload: completeAgentEventPayload("session.created", { workspacePath, mode: "change" })
    }, 0);
    const state = createKernelState({
      sessionId,
      runId,
      mode: "change",
      startedAt,
      deadlineAt: "2026-07-12T00:15:00.000Z"
    });
    state.contextArchive = {
      schemaVersion: 1,
      item: {
        id: "context:model-summary:archive",
        authority: "tool",
        provenance: "model-generated conversation archive",
        content: "## Objective\nPreserve the original goal.",
        tokenCount: 12,
        priority: 600,
        cacheKey: "e".repeat(64)
      },
      omittedHistoryTurns: 7,
      sourceDigest: "e".repeat(64)
    };
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: { ...state, lastSeq: 1 }
    });

    const restored = await restoreStoredSession(store, sessionId, 60_000);
    expect(restored.state.contextArchive).toEqual(state.contextArchive);
  });
});
