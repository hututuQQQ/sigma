import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSessionStorageSupported,
  currentSessionEvents,
  listCurrentSessions
} from "../packages/agent-runtime/src/session-catalog.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";

const roots: string[] = [];

function record(event: Record<string, unknown>): string {
  const checksum = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return JSON.stringify({ checksum, event });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (item) => await rm(item, { recursive: true, force: true })));
});

describe("V4 session compatibility boundary", () => {
  it("lists and replays V3 sessions read-only but refuses execution resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-v3-read-only-"));
    roots.push(root);
    const sessionId = "legacy-v3-session";
    const directory = path.join(root, "stores", "v3", "sessions", sessionId);
    await mkdir(path.join(directory, "events"), { recursive: true });
    const occurredAt = "2026-01-01T00:00:00.000Z";
    const events = [
      { type: "session.created", payload: { workspacePath: "D:/legacy", mode: "analyze" } },
      { type: "run.started", payload: { runId: "run" } },
      { type: "model.completed", payload: { text: "Legacy answer" } },
      { type: "run.completed", payload: { outcome: { kind: "completed", message: "Legacy answer", evidence: [] } } }
    ].map((item, index) => ({
      schemaVersion: 3,
      eventId: `legacy-event-${index + 1}`,
      sessionId,
      seq: index + 1,
      occurredAt,
      authority: "runtime",
      ...item
    }));
    await writeFile(path.join(directory, "events", "000001.jsonl"),
      `${events.map(record).join("\n")}\n`, "utf8");
    await writeFile(path.join(directory, "meta.json"), JSON.stringify({
      schemaVersion: 3, eventSchemaVersion: 3, snapshotSchemaVersion: 3,
      sessionId, createdAt: occurredAt, updatedAt: occurredAt,
      lastSeq: events.length, segment: 1, segmentEvents: events.length
    }), "utf8");
    const store = new SegmentedJsonlStore({ rootDir: root });

    const replayed = [];
    for await (const event of currentSessionEvents(store, root, sessionId)) replayed.push(event);
    expect(replayed).toHaveLength(events.length);
    expect(replayed.every((event) => event.schemaVersion === 4)).toBe(true);
    await expect(listCurrentSessions(store, root, 20)).resolves.toEqual([
      expect.objectContaining({
        sessionId, workspacePath: "D:/legacy", mode: "analyze",
        status: "completed", lastMessage: "Legacy answer"
      })
    ]);
    await expect(assertSessionStorageSupported(root, sessionId)).rejects.toMatchObject({
      code: "incompatible_session_schema"
    });
  });
});
