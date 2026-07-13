import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type JsonValue,
  type ToolDescriptor
} from "../packages/agent-protocol/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { restoreStoredSession } from "../packages/agent-runtime/src/restore-session.js";
import { armRunDeadline } from "../packages/agent-runtime/src/run-deadline.js";
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

  it("defaults semantic progress when restoring a pre-feature V4 snapshot", async () => {
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
    delete oldSnapshot.semanticProgress;
    delete oldSnapshot.semanticFailureCluster;
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId,
      seq: 1,
      createdAt: startedAt,
      state: oldSnapshot
    });

    const restored = await restoreStoredSession(store, sessionId, 60_000);
    expect(restored.state.semanticProgress).toEqual({ workspaceChanges: 0, durableEvidence: 0, revision: 0 });
    expect(restored.state.semanticFailureCluster).toBeUndefined();
  });
});
