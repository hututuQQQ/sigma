import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonValue, LegacyAgentEventEnvelopeV2 } from "../packages/agent-protocol/src/index.js";
import {
  legacySessionDirectoryV2,
  projectMigrationSemantics,
  promoteV2Session,
  SegmentedJsonlStore,
  sessionDirectory,
  V2ReadOnlySessionStore
} from "../packages/agent-store/src/index.js";
import { rebuildV3SnapshotFromEvents } from "../packages/agent-runtime/src/restore-session.js";

interface FixtureEvent {
  runId: string;
  type: LegacyAgentEventEnvelopeV2["type"];
  payload?: JsonValue;
}

function envelope(sessionId: string, seq: number, fixture: FixtureEvent): LegacyAgentEventEnvelopeV2 {
  return {
    schemaVersion: 2,
    seq,
    eventId: `${sessionId}-v2-${seq}`,
    sessionId,
    runId: fixture.runId,
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    type: fixture.type,
    authority: fixture.type.startsWith("user.") ? "user" : "runtime",
    payload: fixture.payload ?? {}
  };
}

async function writeFixture(
  root: string,
  sessionId: string,
  fixtures: FixtureEvent[],
  corruptTail = ""
): Promise<void> {
  const directory = legacySessionDirectoryV2(root, sessionId);
  await mkdir(path.join(directory, "events"), { recursive: true });
  const records = fixtures.map((fixture, index) => envelope(sessionId, index + 1, fixture)).map((event) => ({
    checksum: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
    event
  }));
  await writeFile(
    path.join(directory, "events", "000001.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n${corruptTail}`,
    "utf8"
  );
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(path.join(directory, "meta.json"), `${JSON.stringify({
    schemaVersion: 2,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastSeq: fixtures.length,
    segment: 1,
    segmentEvents: fixtures.length
  })}\n`, "utf8");
}

function sessionCreated(runId = "run-1"): FixtureEvent {
  return { runId, type: "session.created", payload: { workspacePath: ".", mode: "change" } };
}

function completedRun(runId: string, effectRevision: number, summary: string): FixtureEvent[] {
  const callId = `complete-${runId}`;
  const turn = { turnId: 1, effectRevision };
  return [
    { runId, type: "run.started", payload: { mode: "change" } },
    { runId, type: "user.message", payload: { text: `task ${runId}` } },
    { runId, type: "model.started", payload: turn },
    {
      runId,
      type: "model.completed",
      payload: {
        ...turn,
        text: summary,
        message: { role: "assistant", content: summary },
        toolCalls: [{ id: callId, name: "complete_task", arguments: { summary } }]
      }
    },
    { runId, type: "tool.requested", payload: { ...turn, callId, name: "complete_task" } },
    { runId, type: "tool.started", payload: { ...turn, callId, name: "complete_task" } },
    {
      runId,
      type: "tool.completed",
      payload: {
        ...turn,
        callId,
        ok: true,
        output: JSON.stringify({ summary }),
        observedEffects: ["outcome.propose"],
        artifacts: [],
        diagnostics: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z"
      }
    },
    { runId, type: "run.completed", payload: { message: summary } }
  ];
}

function needsInputRun(runId: string, message: string): FixtureEvent[] {
  return [
    { runId, type: "run.started", payload: { mode: "change" } },
    { runId, type: "user.message", payload: { text: `task ${runId}` } },
    { runId, type: "run.suspended", payload: { requestId: `input-${runId}`, message } }
  ];
}

function pendingApprovalRun(runId: string): FixtureEvent[] {
  const callId = `write-${runId}`;
  const turn = { turnId: 1, effectRevision: 3 };
  return [
    { runId, type: "run.started", payload: { mode: "change" } },
    { runId, type: "user.message", payload: { text: "write a file" } },
    { runId, type: "model.started", payload: turn },
    {
      runId,
      type: "model.completed",
      payload: {
        ...turn,
        text: "I will write it.",
        message: { role: "assistant", content: "I will write it." },
        toolCalls: [{ id: callId, name: "write", arguments: { path: "answer.md" } }]
      }
    },
    {
      runId,
      type: "tool.approval_requested",
      payload: {
        ...turn,
        requestId: callId,
        callId,
        toolName: "write",
        effects: ["filesystem.write"],
        reason: "workspace mutation",
        arguments: { path: "answer.md" }
      }
    },
    {
      runId,
      type: "run.suspended",
      payload: { ...turn, requestId: callId, callId, message: "Approval required for write." }
    }
  ];
}

interface ExpectedFixture {
  phase: "needs_input" | "terminal";
  outcome: string;
  approvals: number;
  boundaries: number;
}

async function assertPromotedFixture(
  root: string,
  sessionId: string,
  fixtures: FixtureEvent[],
  expected: ExpectedFixture
): Promise<void> {
  await writeFixture(root, sessionId, fixtures);
  const legacy = new V2ReadOnlySessionStore(root);
  const source = await projectMigrationSemantics(sessionId, legacy.events(sessionId));
  const result = await promoteV2Session({ rootDir: root, sessionId, rebuildSnapshot: rebuildV3SnapshotFromEvents });
  const targetStore = new SegmentedJsonlStore({ rootDir: root });
  const target = await projectMigrationSemantics(sessionId, targetStore.events(sessionId));
  expect(result).toMatchObject({ status: "promoted", semanticDigest: source.semanticDigest });
  expect(target).toEqual(source);
  expect(target).toMatchObject({
    phase: expected.phase,
    outcome: { kind: expected.outcome },
    runBoundaryCount: expected.boundaries
  });
  expect(target.pendingApprovals).toHaveLength(expected.approvals);
  const snapshot = await targetStore.latestSnapshot(sessionId);
  expect(snapshot?.state).toMatchObject({
    phase: expected.phase,
    outcome: { kind: expected.outcome },
    pendingTools: expected.approvals === 0
      ? expect.any(Array)
      : [expect.objectContaining({ approval: "pending" })]
  });
}

describe("V2 to V3 migration semantic equivalence", () => {
  it("replays completed, multi-run, NeedsInput, and pending-approval fixtures equivalently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-v2-semantics-"));
    try {
      await assertPromotedFixture(root, "completed", [
        sessionCreated(),
        ...completedRun("run-1", 3, "completed")
      ], { phase: "terminal", outcome: "completed", approvals: 0, boundaries: 2 });
      await assertPromotedFixture(root, "multi-run", [
        sessionCreated(),
        ...completedRun("run-1", 3, "first completed"),
        ...needsInputRun("run-2", "Need a second-run choice.")
      ], { phase: "needs_input", outcome: "needs_input", approvals: 0, boundaries: 4 });
      await assertPromotedFixture(root, "needs-input", [
        sessionCreated(),
        ...needsInputRun("run-1", "Which target?")
      ], { phase: "needs_input", outcome: "needs_input", approvals: 0, boundaries: 2 });
      await assertPromotedFixture(root, "pending-approval", [
        sessionCreated(),
        ...pendingApprovalRun("run-1")
      ], { phase: "needs_input", outcome: "needs_input", approvals: 1, boundaries: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fully replays an already-v3 target and rejects replay drift despite valid metadata and checksums", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-v2-existing-semantics-"));
    const sessionId = "already-v3-drift";
    try {
      await writeFixture(root, sessionId, [sessionCreated(), ...completedRun("run-1", 3, "original")]);
      await promoteV2Session({ rootDir: root, sessionId, rebuildSnapshot: rebuildV3SnapshotFromEvents });
      let replayCount = 0;
      await expect(promoteV2Session({
        rootDir: root,
        sessionId,
        rebuildSnapshot: async (input) => {
          replayCount += 1;
          return await rebuildV3SnapshotFromEvents(input);
        }
      })).resolves.toMatchObject({ status: "already_v3" });
      expect(replayCount).toBe(1);

      const segment = path.join(sessionDirectory(root, sessionId), "events", "000001.jsonl");
      const records = (await readFile(segment, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as {
        checksum: string;
        event: { type: string; payload: Record<string, JsonValue> };
      });
      const completed = records.find((record) => record.event.type === "run.completed")!;
      completed.event.payload.outcomeRevision = 999;
      completed.checksum = createHash("sha256").update(JSON.stringify(completed.event)).digest("hex");
      await writeFile(segment, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

      await expect(promoteV2Session({ rootDir: root, sessionId, rebuildSnapshot: rebuildV3SnapshotFromEvents }))
        .rejects.toThrow("migration semantic mismatch in replayed 'phase'");

      completed.event.payload.outcomeRevision = 8;
      completed.checksum = createHash("sha256").update(JSON.stringify(completed.event)).digest("hex");
      const userMessage = records.find((record) => record.event.type === "user.message")!;
      userMessage.event.payload.text = "drifted transcript";
      userMessage.checksum = createHash("sha256").update(JSON.stringify(userMessage.event)).digest("hex");
      await writeFile(segment, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
      await expect(promoteV2Session({ rootDir: root, sessionId }))
        .rejects.toThrow("migration semantic mismatch in 'transcriptDigest'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only a torn final tail and rejects a newline-terminated corrupt tail without publishing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-v2-corrupt-tail-"));
    try {
      await writeFixture(root, "torn-tail", [sessionCreated()], "{\"incomplete\"");
      await expect(promoteV2Session({
        rootDir: root,
        sessionId: "torn-tail",
        rebuildSnapshot: rebuildV3SnapshotFromEvents
      })).resolves.toMatchObject({ status: "promoted", incompleteTail: true });

      await writeFixture(root, "complete-corrupt-tail", [sessionCreated()], "{\"corrupt\"\n");
      await expect(promoteV2Session({
        rootDir: root,
        sessionId: "complete-corrupt-tail",
        rebuildSnapshot: rebuildV3SnapshotFromEvents
      })).rejects.toThrow();
      await expect(readFile(path.join(sessionDirectory(root, "complete-corrupt-tail"), "meta.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
