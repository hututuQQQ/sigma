import { mkdtemp } from "node:fs/promises";
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
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { restoreStoredSession } from "../packages/agent-runtime/src/restore-session.js";
import { armRunDeadline } from "../packages/agent-runtime/src/run-deadline.js";
import { convergedToolFailure } from "../packages/agent-runtime/src/capability-failure-convergence.js";
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

describe("runtime recovery convergence", () => {
  it("counts repeated capability failures per semantic invocation", () => {
    const session = runtimeSessionFixture();
    session.interaction.capabilityFailures = new Map();
    const signal = new AbortController().signal;
    const failure = Object.assign(new Error("runtime unavailable"), { code: "toolchain_unavailable" });
    const first = { id: "first", name: "exec", arguments: { executable: "node", args: ["--version"] } };
    const different = { id: "different", name: "exec", arguments: { executable: "pnpm", args: ["test"] } };
    expect(convergedToolFailure(
      session, first, "2026-01-01T00:00:00.000Z", failure, signal
    ).diagnostics).toContain("toolchain_unavailable");
    expect(convergedToolFailure(
      session, different, "2026-01-01T00:00:00.000Z", failure, signal
    ).diagnostics).toContain("toolchain_unavailable");
    expect(convergedToolFailure(
      session, { ...first, id: "retry" }, "2026-01-01T00:00:00.000Z", failure, signal
    ).diagnostics).toContain("capability_retry_exhausted");
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
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspacePath, ".agent") });
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
    delete oldSnapshot.taskControl;
    Object.assign(oldSnapshot, {
      completionRepairAttempts: 0,
      continuationAttempts: 0,
      repeatedToolBatchCount: 0,
      receiptCountAtLastUserInput: 0,
      semanticProgress: { workspaceChanges: 0, durableEvidence: 0, revision: 0 }
    });
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: oldSnapshot
    });

    const restored = await restoreStoredSession(store, sessionId, 60_000);
    expect(restored.state.taskControl).toMatchObject({
      schemaVersion: 1,
      phase: "normal",
      semanticFacts: { entries: [] }
    });
    for (const key of [
      "completionRepairAttempts", "completionRepair", "continuationAttempts",
      "repeatedToolBatchCount", "receiptCountAtLastUserInput", "semanticProgress",
      "semanticFailureCluster", "lastToolBatchSignature", "lastToolBatchOutcomeSignature"
    ]) expect(restored.state).not.toHaveProperty(key);
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
});
