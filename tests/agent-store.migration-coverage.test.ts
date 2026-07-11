import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type JsonValue,
  type LegacyAgentEventEnvelopeV2,
  type SnapshotEnvelope
} from "../packages/agent-protocol/src/index.js";
import {
  assertMigrationReplaySnapshot,
  assertMigrationSemanticEquivalence,
  legacySessionDirectoryV2,
  projectMigrationSemantics,
  promoteV2Session,
  sessionDirectory,
  V2ReadOnlySessionStore,
  type LegacySessionInspectionV2
} from "../packages/agent-store/src/index.js";
import {
  copyLegacyEvents,
  type PromotionCopyContext
} from "../packages/agent-store/src/migration-staging.js";

function event(
  seq: number,
  type: AgentEventType,
  payload: unknown = {},
  options: { sessionId?: string; runId?: string; eventId?: string } = {}
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: options.eventId ?? `event-${seq}`,
    sessionId: options.sessionId ?? "semantic",
    runId: options.runId ?? "run",
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    type,
    authority: type.startsWith("user.") ? "user" : "runtime",
    payload: payload as JsonValue
  };
}

async function* stream(values: AgentEventEnvelope[]): AsyncIterable<AgentEventEnvelope> {
  for (const value of values) yield value;
}

async function projection(values: AgentEventEnvelope[], sessionId = "semantic") {
  return await projectMigrationSemantics(sessionId, stream(values));
}

function snapshot(sessionId: string, seq: number, state: JsonValue): SnapshotEnvelope {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    storeLayoutVersion: STORE_LAYOUT_VERSION,
    sessionId,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    state
  };
}

function legacyEvent(sessionId: string, seq: number): LegacyAgentEventEnvelopeV2 {
  return {
    schemaVersion: 2,
    seq,
    eventId: `${sessionId}-${seq}`,
    sessionId,
    runId: "run",
    occurredAt: new Date(1_600_000_000_000 + seq).toISOString(),
    type: seq === 1 ? "session.created" : "diagnostic",
    authority: "runtime",
    payload: { seq }
  };
}

async function writeLegacy(root: string, sessionId: string, lineEnding = "\n"): Promise<void> {
  const directory = legacySessionDirectoryV2(root, sessionId);
  await mkdir(path.join(directory, "events"), { recursive: true });
  const item = legacyEvent(sessionId, 1);
  const checksum = createHash("sha256").update(JSON.stringify(item)).digest("hex");
  await writeFile(
    path.join(directory, "events", "000001.jsonl"),
    `${JSON.stringify({ checksum, event: item })}${lineEnding}${lineEnding}`,
    "utf8"
  );
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(path.join(directory, "meta.json"), JSON.stringify({
    schemaVersion: 2,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastSeq: 1,
    segment: 1,
    segmentEvents: 1
  }), "utf8");
}

function rebuilt(sessionId: string, seq: number, state: JsonValue = { rebuilt: true }): SnapshotEnvelope {
  return snapshot(sessionId, seq, state);
}

describe("migration security branch coverage", () => {
  it("normalizes every transcript shape without depending on streaming chunk boundaries", async () => {
    const projected = await projection([
      event(1, "session.created", null),
      event(2, "run.started", { mode: 1 }),
      event(3, "user.steer", { text: 7 }),
      event(4, "user.follow_up", { status: "queued", text: "later" }),
      event(5, "user.follow_up", { status: "delivered", text: "now" }),
      event(6, "model.delta", { delta: "a" }),
      event(7, "model.delta", { turnId: "other", delta: "b" }),
      event(8, "model.completed", { turnId: "other", message: { content: "stream fallback" } }),
      event(9, "model.completed", { turnId: 3, message: { content: "message fallback" } }),
      event(10, "model.completed", { turnId: 4, message: null }),
      event(11, "model.completed", { turnId: 5, message: [] }),
      event(12, "diagnostic", [])
    ]);
    expect(projected).toMatchObject({ phase: "running", transcriptEntries: 5, eventCount: 12 });
  });

  it("projects approval fallbacks and every terminal outcome deterministically", async () => {
    const projected = await projection([
      event(1, "session.created"),
      event(2, "run.started"),
      event(3, "tool.approval_requested", { callId: "call-only" }),
      event(4, "tool.approval_requested", { requestId: "request-only", effects: [1, "write"] }),
      event(5, "tool.approval_requested", {}, { eventId: "fallback-id" }),
      event(6, "run.suspended", { message: "approval" }),
      event(7, "tool.approval_resolved", { callId: "call-only" }),
      event(8, "tool.approval_resolved", { requestId: "request-only" }),
      event(9, "tool.approval_resolved", {}, { eventId: "fallback-id" }),
      event(10, "run.cancelled", {}),
      event(11, "run.started", {}, { runId: "run-2" }),
      event(12, "run.failed", { kind: "recoverable_failure", resumeToken: "resume" }, { runId: "run-2" }),
      event(13, "run.started", {}, { runId: "run-3" }),
      event(14, "run.failed", { kind: "fatal", code: "broken", message: "failed" }, { runId: "run-3" }),
      event(15, "run.started", {}, { runId: "run-4" }),
      event(16, "run.cancelled", { reason: "operator" }, { runId: "run-4" })
    ]);
    expect(projected).toMatchObject({
      phase: "terminal",
      outcome: { kind: "cancelled", reason: "operator" },
      pendingApprovals: [],
      runBoundaryCount: 9
    });
  });

  it("fails closed on replay identity, sequence, outcome, and approval mismatches", async () => {
    await expect(projection([event(1, "diagnostic", {}, { sessionId: "other" })]))
      .rejects.toThrow("session mismatch");
    await expect(projection([event(2, "diagnostic")])).rejects.toThrow("sequence discontinuity");

    const completed = await projection([event(1, "run.completed", {})]);
    assertMigrationReplaySnapshot(completed, snapshot("semantic", 1, {
      phase: "terminal", outcome: { kind: "completed", message: 4 }, pendingTools: null
    }));
    expect(() => assertMigrationReplaySnapshot(completed, snapshot("semantic", 1, {
      phase: "terminal", outcome: { kind: "completed", message: "different" }, pendingTools: []
    }))).toThrow("replayed 'outcome'");

    const pending = await projection([event(1, "tool.approval_requested", { requestId: "approval" })]);
    expect(() => assertMigrationReplaySnapshot(pending, snapshot("semantic", 1, {
      phase: "needs_input", outcome: null, pendingTools: []
    }))).toThrow("replayed 'pendingApprovals'");

    const undefinedOutcome = { ...completed, outcome: undefined as never };
    expect(() => assertMigrationSemanticEquivalence(completed, undefinedOutcome)).toThrow("semantic mismatch");
  });

  it("normalizes kernel replay states including malformed pending entries", async () => {
    const cases: Array<{ projected: Awaited<ReturnType<typeof projection>>; state: JsonValue }> = [
      {
        projected: await projection([event(1, "run.suspended", {})]),
        state: { phase: "needs_input", outcome: { kind: "needs_input" }, pendingTools: [] }
      },
      {
        projected: await projection([event(1, "run.cancelled", {})]),
        state: { phase: "terminal", outcome: { kind: "cancelled" }, pendingTools: [] }
      },
      {
        projected: await projection([event(1, "run.failed", { kind: "recoverable_failure", resumeToken: "r" })]),
        state: { phase: "terminal", outcome: { kind: "recoverable_failure", resumeToken: "r" }, pendingTools: [] }
      },
      {
        projected: await projection([event(1, "run.failed", { kind: "fatal", code: "x", message: "y" })]),
        state: { phase: "terminal", outcome: { kind: "fatal", code: "x", message: "y" }, pendingTools: [] }
      },
      {
        projected: await projection([event(1, "run.started")]),
        state: {
          phase: "ready_model",
          outcome: null,
          pendingTools: [null, { approval: "pending", request: null }, { approval: "allowed", request: { callId: "x" } },
            { approval: "pending", request: {} }]
        }
      },
      { projected: await projection([]), state: { phase: "idle", outcome: null, pendingTools: null } }
    ];
    for (const [index, item] of cases.entries()) {
      expect(() => assertMigrationReplaySnapshot(item.projected, snapshot("semantic", index, item.state))).not.toThrow();
    }
    expect(() => assertMigrationReplaySnapshot(cases[0]!.projected, snapshot("semantic", 0, {}))).not.toThrow();
  });

  it("rejects discontinuous and incomplete streams while staging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-migration-staging-coverage-"));
    const source: LegacySessionInspectionV2 = {
      storeLayoutVersion: 2,
      eventSchemaVersion: 2,
      sessionId: "staging",
      sourceDirectory: path.join(root, "sessions", "staging"),
      sourceDigest: "a".repeat(64),
      metaDigest: "b".repeat(64),
      segments: [],
      eventCount: 1,
      lastSeq: 1,
      metaLastSeq: 1,
      incompleteTail: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const context = (values: LegacyAgentEventEnvelopeV2[]): PromotionCopyContext => ({
      sessionId: "staging",
      legacy: { events: async function* () { for (const value of values) yield value; } } as V2ReadOnlySessionStore
    });
    try {
      await expect(copyLegacyEvents(
        { rootDir: root, sessionId: "staging" },
        context([legacyEvent("staging", 2)]),
        source,
        path.join(root, "discontinuous")
      )).rejects.toThrow("sequence discontinuity");
      await expect(copyLegacyEvents(
        { rootDir: root, sessionId: "staging" },
        context([legacyEvent("staging", 1)]),
        { ...source, lastSeq: 2 },
        path.join(root, "incomplete")
      )).rejects.toThrow("expected seq 2, actual 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fully validates existing replay scope and an invalid publish-race target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-migration-publish-coverage-"));
    try {
      await writeLegacy(root, "existing-replay");
      await promoteV2Session({
        rootDir: root,
        sessionId: "existing-replay",
        rebuildSnapshot: async ({ sessionId, lastSeq }) => rebuilt(sessionId, lastSeq)
      });
      await expect(promoteV2Session({
        rootDir: root,
        sessionId: "existing-replay",
        rebuildSnapshot: async ({ sessionId, lastSeq }) => rebuilt(`${sessionId}-wrong`, lastSeq)
      })).rejects.toThrow("does not match existing session");

      await writeLegacy(root, "invalid-publish-race");
      await expect(promoteV2Session({
        rootDir: root,
        sessionId: "invalid-publish-race",
        rebuildSnapshot: async ({ sessionId, lastSeq }) => {
          const target = sessionDirectory(root, sessionId);
          await mkdir(target, { recursive: true });
          await writeFile(path.join(target, "meta.json"), "{}", "utf8");
          return rebuilt(sessionId, lastSeq);
        }
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams CRLF records and propagates non-ENOENT metadata and complete-record errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-legacy-stream-coverage-"));
    const store = new V2ReadOnlySessionStore(root);
    try {
      await writeLegacy(root, "crlf", "\r\n");
      await expect(store.inspect("crlf")).resolves.toMatchObject({ eventCount: 1, lastSeq: 1 });

      const metadataDirectory = legacySessionDirectoryV2(root, "metadata-directory");
      await mkdir(path.join(metadataDirectory, "meta.json"), { recursive: true });
      await expect(store.inspect("metadata-directory")).rejects.not.toThrow("does not exist");

      const bad = legacySessionDirectoryV2(root, "bad-complete-record");
      await mkdir(path.join(bad, "events"), { recursive: true });
      await writeFile(path.join(bad, "events", "000001.jsonl"), "{\"checksum\":\"digest\"}\n", "utf8");
      const consume = async (): Promise<void> => { for await (const _event of store.events("bad-complete-record")) { /* validate */ } };
      await expect(consume()).rejects.toThrow("Invalid V2 event record envelope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
