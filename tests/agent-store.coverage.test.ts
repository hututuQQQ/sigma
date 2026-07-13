import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type AgentEventEnvelope,
  type LegacyAgentEventEnvelopeV2
} from "../packages/agent-protocol/src/index.js";
import {
  ContentAddressedArtifactStore,
  JsonlEvaluationSink,
  assertPromotedV2SourceUnchanged,
  legacySessionDirectoryV2,
  promoteV2Session,
  safeId,
  segmentName,
  SegmentedJsonlStore,
  sessionDirectory,
  sessionsDirectory,
  snapshotName,
  V2ReadOnlySessionStore
} from "../packages/agent-store/src/index.js";

function event(sessionId: string, seq: number, type: AgentEventEnvelope["type"] = "diagnostic"): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: `${sessionId}-${seq}`,
    sessionId,
    runId: "run",
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    type,
    authority: "runtime",
    payload: { seq }
  };
}

function legacyEvent(sessionId: string, seq: number): LegacyAgentEventEnvelopeV2 {
  return {
    schemaVersion: 2,
    seq,
    eventId: `${sessionId}-v2-${seq}`,
    sessionId,
    runId: "run",
    occurredAt: new Date(1_600_000_000_000 + seq).toISOString(),
    type: seq === 1 ? "session.created" : "diagnostic",
    authority: "runtime",
    payload: { seq }
  };
}

async function writeLegacySession(root: string, sessionId: string, count: number, tornTail = false): Promise<void> {
  const directory = legacySessionDirectoryV2(root, sessionId);
  await mkdir(path.join(directory, "events"), { recursive: true });
  const records = Array.from({ length: count }, (_, index) => legacyEvent(sessionId, index + 1)).map((item) => ({
    checksum: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
    event: item
  }));
  const tail = tornTail ? "{\"incomplete\"" : "";
  await writeFile(path.join(directory, "events", "000001.jsonl"), `${records.map((item) => JSON.stringify(item)).join("\n")}\n${tail}`, "utf8");
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(path.join(directory, "meta.json"), `${JSON.stringify({
    schemaVersion: 2,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastSeq: count,
    segment: 1,
    segmentEvents: count
  }, null, 2)}\n`, "utf8");
}

describe("agent-store crash and validation coverage", () => {
  it.skipIf(process.platform === "win32")(
    "creates a new durable state tree with owner-only permissions",
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "sigma-private-store-"));
      const root = path.join(parent, "state");
      const store = new SegmentedJsonlStore({ rootDir: root });
      await store.append(event("private", 1, "session.created"), 0);

      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(sessionDirectory(root, "private"))).mode & 0o777).toBe(0o700);
    }
  );

  it("stores content-addressed artifacts idempotently and validates identifiers", async () => {
    const actualRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-artifacts-"));
    const artifacts = new ContentAddressedArtifactStore(actualRoot);
    const digest = await artifacts.put("session", "hello");
    expect(await artifacts.put("session", new TextEncoder().encode("hello"))).toBe(digest);
    expect((await artifacts.get("session", digest)).toString("utf8")).toBe("hello");
    await expect(artifacts.get("session", "bad")).rejects.toThrow("Invalid artifact digest");
    await writeFile(path.join(sessionDirectory(actualRoot, "session"), "artifacts", digest), "corrupt");
    await expect(artifacts.put("session", "hello")).rejects.toThrow("Artifact CAS object");
    await expect(artifacts.get("session", digest)).rejects.toThrow("Artifact CAS object");
    for (const invalid of [".", "..", "x".repeat(129), "path/escape"]) expect(() => safeId(invalid)).toThrow("Unsafe");
    expect(safeId("valid.session-1")).toBe("valid.session-1");
    expect(sessionDirectory(actualRoot, "session")).toContain(path.join("sessions", "session"));
    expect(segmentName(3)).toBe("000003.jsonl");
    expect(snapshotName(12)).toBe("000000000012.json");
    await rm(actualRoot, { recursive: true, force: true });
  });

  it("rotates segments, filters replay, and rejects sequence conflicts", async () => {
    const root = path.join(os.tmpdir(), `sigma-segments-${Date.now()}-${Math.random()}`);
    const store = new SegmentedJsonlStore({ rootDir: root, segmentEvents: 1, segmentBytes: 1_000_000 });
    expect(await store.append(event("rotate", 1, "session.created"), 0)).toEqual({ rotated: false });
    expect(await store.append(event("rotate", 2), 1)).toEqual({ rotated: true });
    expect((await readdir(path.join(sessionDirectory(root, "rotate"), "events"))).sort()).toEqual(["000001.jsonl", "000002.jsonl"]);
    const filtered: number[] = [];
    for await (const item of store.events("rotate", 1)) filtered.push(item.seq);
    expect(filtered).toEqual([2]);
    await expect(store.append(event("rotate", 4), 2)).rejects.toThrow("must equal 3");
    await expect(store.append(event("rotate", 3), 1)).rejects.toThrow("sequence conflict");
  });

  it("repairs valid and torn no-newline tails only under the append lock", async () => {
    const root = path.join(os.tmpdir(), `sigma-tail-${Date.now()}-${Math.random()}`);
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("tail", 1, "session.created"), 0);
    const eventPath = path.join(sessionDirectory(root, "tail"), "events", "000001.jsonl");
    const complete = await readFile(eventPath, "utf8");
    await writeFile(eventPath, complete.trimEnd(), "utf8");
    const readOnly: number[] = [];
    for await (const item of store.events("tail")) readOnly.push(item.seq);
    expect(readOnly).toEqual([1]);
    expect((await readFile(eventPath, "utf8")).endsWith("\n")).toBe(false);
    await store.append(event("tail", 2), 1);
    expect((await readFile(eventPath, "utf8")).endsWith("\n")).toBe(true);

    await writeFile(eventPath, `${await readFile(eventPath, "utf8")}{"broken"`, "utf8");
    await store.append(event("tail", 3), 2);
    const restored: number[] = [];
    for await (const item of store.events("tail")) restored.push(item.seq);
    expect(restored).toEqual([1, 2, 3]);
  });

  it("reconciles a durable event when its metadata replace failed", async () => {
    const root = path.join(os.tmpdir(), `sigma-meta-crash-${Date.now()}-${Math.random()}`);
    let armed = false;
    let failed = false;
    const store = new SegmentedJsonlStore({
      rootDir: root,
      replaceFile: async (source, target) => {
        if (armed && !failed && target.endsWith("meta.json")) {
          failed = true;
          const durable = await readFile(path.join(sessionDirectory(root, "meta-crash"), "events", "000001.jsonl"), "utf8");
          expect(durable.trimEnd().split("\n")).toHaveLength(2);
          throw Object.assign(new Error("injected metadata replace failure"), { code: "EIO" });
        }
        await rename(source, target);
      }
    });
    await store.append(event("meta-crash", 1, "session.created"), 0);
    armed = true;
    await expect(store.append(event("meta-crash", 2), 1)).rejects.toThrow("injected metadata replace failure");

    const recovered = new SegmentedJsonlStore({ rootDir: root });
    await expect(recovered.append(event("meta-crash", 2), 1)).rejects.toThrow("actual 2");
    await recovered.append(event("meta-crash", 3), 2);
    const sequences: number[] = [];
    for await (const stored of recovered.events("meta-crash")) sequences.push(stored.seq);
    expect(sequences).toEqual([1, 2, 3]);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("retries transient Windows-style atomic replace failures without exposing partial JSON", async () => {
    const root = path.join(os.tmpdir(), `sigma-meta-retry-${Date.now()}-${Math.random()}`);
    let attempts = 0;
    const store = new SegmentedJsonlStore({
      rootDir: root,
      replaceFile: async (source, target) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("sharing violation"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
        await rename(source, target);
      }
    });

    await store.append(event("meta-retry", 1, "session.created"), 0);
    expect(attempts).toBe(3);
    const directory = sessionDirectory(root, "meta-retry");
    const meta = JSON.parse(await readFile(path.join(directory, "meta.json"), "utf8")) as { lastSeq: number };
    expect(meta.lastSeq).toBe(1);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("detects durable corruption and recovers stale locks", async () => {
    const root = path.join(os.tmpdir(), `sigma-corruption-${Date.now()}-${Math.random()}`);
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("corrupt", 1, "session.created"), 0);
    const directory = sessionDirectory(root, "corrupt");
    const lock = path.join(directory, ".append.lock");
    await writeFile(lock, "stale", "utf8");
    const old = new Date(Date.now() - 180_000);
    await utimes(lock, old, old);
    await store.append(event("corrupt", 2), 1);

    const eventPath = path.join(directory, "events", "000001.jsonl");
    const lines = (await readFile(eventPath, "utf8")).trimEnd().split("\n");
    const record = JSON.parse(lines[0]) as { checksum: string };
    lines[0] = JSON.stringify({ ...record, checksum: "0".repeat(64) });
    await writeFile(eventPath, `${lines.join("\n")}\n`, "utf8");
    const consume = async (): Promise<void> => { for await (const _item of store.events("corrupt")) { /* validate */ } };
    await expect(consume()).rejects.toThrow("checksum mismatch");

    await writeFile(path.join(directory, "meta.json"), "not json", "utf8");
    await expect(store.append(event("corrupt", 3), 2)).rejects.toThrow("metadata is corrupt");
  });

  it("falls back across corrupt snapshots, lists valid sessions, and isolates evaluation reports", async () => {
    const root = path.join(os.tmpdir(), `sigma-snapshots-${Date.now()}-${Math.random()}`);
    const store = new SegmentedJsonlStore({ rootDir: root });
    expect(await store.latestSnapshot("missing")).toBeNull();
    await store.append(event("snap", 1, "session.created"), 0);
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId: "snap", seq: 1, createdAt: "2026-01-01T00:00:00.000Z", state: { value: 1 }
    });
    await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId: "snap", seq: 2, createdAt: "2026-01-01T00:00:01.000Z", state: { value: 2 }
    });
    const latest = path.join(sessionDirectory(root, "snap"), "snapshots", snapshotName(2));
    await writeFile(latest, "{corrupt", "utf8");
    await expect(store.latestSnapshot("snap")).resolves.toMatchObject({ seq: 1, state: { value: 1 } });

    await mkdir(path.join(sessionsDirectory(root), "invalid"), { recursive: true });
    await writeFile(path.join(sessionsDirectory(root), "invalid", "meta.json"), "bad", "utf8");
    await store.append({ ...event("newer", 1, "session.created"), occurredAt: "2099-01-01T00:00:00.000Z" }, 0);
    expect((await store.listSessions()).map((item) => item.sessionId)).toEqual(["newer", "snap"]);

    const sink = new JsonlEvaluationSink(root);
    await sink.append({ schemaVersion: 1, reportId: "one", occurredAt: "now", evaluator: "human", payload: { score: 1 } });
    await sink.append({ schemaVersion: 1, reportId: "two", occurredAt: "later", evaluator: "human", payload: null });
    const reports = (await readFile(path.join(root, "evaluation-reports", "reports.jsonl"), "utf8")).trim().split("\n");
    expect(reports).toHaveLength(2);
    expect(await store.listSessions()).toHaveLength(2);
  });

  it("promotes immutable V2 sessions copy-on-write and rebuilds V3 snapshots", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-promotion-${Date.now()}-${Math.random()}`);
    await writeLegacySession(root, "legacy", 3, true);
    const legacyDirectory = legacySessionDirectoryV2(root, "legacy");
    const sourceMeta = await readFile(path.join(legacyDirectory, "meta.json"));
    const sourceEvents = await readFile(path.join(legacyDirectory, "events", "000001.jsonl"));

    const dryRun = await promoteV2Session({ rootDir: root, sessionId: "legacy", dryRun: true });
    expect(dryRun).toMatchObject({ status: "dry_run", lastSeq: 3, eventCount: 3, incompleteTail: true });
    expect((await readdir(legacyDirectory)).sort()).toEqual(["events", "meta.json"]);
    await expect(readFile(path.join(sessionDirectory(root, "legacy"), "meta.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const promoted = await promoteV2Session({
      rootDir: root,
      sessionId: "legacy",
      now: () => "2026-01-02T00:00:00.000Z",
      rebuildSnapshot: async ({ sessionId, lastSeq, events }) => {
        const versions: number[] = [];
        for await (const item of events()) versions.push(item.schemaVersion);
        expect(versions).toEqual([3, 3, 3]);
        return {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          storeLayoutVersion: STORE_LAYOUT_VERSION,
          sessionId,
          seq: lastSeq,
          createdAt: "2026-01-02T00:00:00.000Z",
          state: { rebuilt: true }
        };
      }
    });
    expect(promoted).toMatchObject({ status: "promoted", snapshot: "rebuilt", lastSeq: 3 });
    expect(await readFile(path.join(legacyDirectory, "meta.json"))).toEqual(sourceMeta);
    expect(await readFile(path.join(legacyDirectory, "events", "000001.jsonl"))).toEqual(sourceEvents);
    expect((await readdir(legacyDirectory)).sort()).toEqual(["events", "meta.json"]);

    const store = new SegmentedJsonlStore({ rootDir: root });
    const events: AgentEventEnvelope[] = [];
    for await (const item of store.events("legacy")) events.push(item);
    expect(events).toHaveLength(3);
    expect(events.every((item) => item.schemaVersion === EVENT_SCHEMA_VERSION)).toBe(true);
    await expect(store.latestSnapshot("legacy")).resolves.toMatchObject({ seq: 3, state: { rebuilt: true } });
    const manifest = JSON.parse(await readFile(path.join(sessionDirectory(root, "legacy"), "migration.json"), "utf8")) as {
      source: { digest: string };
      target: { digest: string; snapshot: string };
    };
    expect(manifest.source.digest).toBe(promoted.sourceDigest);
    expect(manifest.target).toMatchObject({ digest: promoted.targetDigest, snapshot: "rebuilt" });
    await expect(assertPromotedV2SourceUnchanged(root, "legacy")).resolves.toBeUndefined();

    await expect(promoteV2Session({ rootDir: root, sessionId: "legacy" })).resolves.toMatchObject({ status: "already_v3" });
    await writeLegacySession(root, "legacy", 4);
    await expect(assertPromotedV2SourceUnchanged(root, "legacy"))
      .rejects.toMatchObject({ code: "v2_source_diverged" });
  });

  it("rejects corrupt V2 records without publishing a partial V3 target", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-corrupt-${Date.now()}-${Math.random()}`);
    await writeLegacySession(root, "legacy-corrupt", 1);
    const source = path.join(legacySessionDirectoryV2(root, "legacy-corrupt"), "events", "000001.jsonl");
    const record = JSON.parse((await readFile(source, "utf8")).trim()) as { event: unknown };
    await writeFile(source, `${JSON.stringify({ ...record, checksum: "0".repeat(64) })}\n`, "utf8");
    await expect(promoteV2Session({ rootDir: root, sessionId: "legacy-corrupt" })).rejects.toThrow("checksum mismatch");
    await expect(readFile(path.join(sessionDirectory(root, "legacy-corrupt"), "meta.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(promoteV2Session({ rootDir: root, sessionId: "missing" })).rejects.toThrow("does not exist");
  });

  it("requires a V3 replayer and removes failed promotion staging directories", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-replayer-${Date.now()}-${Math.random()}`);
    await writeLegacySession(root, "needs-replay", 1);

    await expect(promoteV2Session({ rootDir: root, sessionId: "needs-replay" }))
      .rejects.toThrow("requires a V3 event replayer");
    expect((await readdir(legacySessionDirectoryV2(root, "needs-replay"))).sort()).toEqual(["events", "meta.json"]);

    const v3Root = path.dirname(sessionsDirectory(root));
    const staging = (await readdir(v3Root).catch(() => []))
      .filter((name) => name.startsWith(".promotion-needs-replay-"));
    expect(staging).toEqual([]);
    await expect(readFile(path.join(sessionDirectory(root, "needs-replay"), "meta.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates V2 metadata and filters corrupt catalog entries without mutating them", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-catalog-${Date.now()}-${Math.random()}`);
    const legacy = new V2ReadOnlySessionStore(root);
    await expect(legacy.inspect("missing")).rejects.toThrow("does not exist");
    await writeLegacySession(root, "valid", 2, true);
    const sequences: number[] = [];
    for await (const item of legacy.events("valid", 1)) sequences.push(item.seq);
    expect(sequences).toEqual([2]);
    await expect(legacy.inspect("valid")).resolves.toMatchObject({ eventCount: 2, lastSeq: 2, incompleteTail: true });

    await writeLegacySession(root, "corrupt-json", 1);
    await writeFile(path.join(legacySessionDirectoryV2(root, "corrupt-json"), "meta.json"), "{", "utf8");
    await expect(legacy.inspect("corrupt-json")).rejects.toThrow("metadata is corrupt");
    await writeLegacySession(root, "invalid-meta", 1);
    await writeFile(path.join(legacySessionDirectoryV2(root, "invalid-meta"), "meta.json"), "{}\n", "utf8");
    await expect(legacy.inspect("invalid-meta")).rejects.toThrow("Invalid V2 session metadata");
    await writeLegacySession(root, "array-meta", 1);
    await writeFile(path.join(legacySessionDirectoryV2(root, "array-meta"), "meta.json"), "[]\n", "utf8");
    await expect(legacy.inspect("array-meta")).rejects.toThrow("Invalid V2 session metadata");

    await writeLegacySession(root, "ahead", 1);
    const aheadMetaPath = path.join(legacySessionDirectoryV2(root, "ahead"), "meta.json");
    const aheadMeta = JSON.parse(await readFile(aheadMetaPath, "utf8")) as Record<string, unknown>;
    await writeFile(aheadMetaPath, `${JSON.stringify({ ...aheadMeta, lastSeq: 2 })}\n`, "utf8");
    await expect(legacy.inspect("ahead")).rejects.toThrow("metadata is ahead");

    const sessions = await legacy.listSessions();
    expect(sessions.map((item) => item.sessionId)).toEqual(expect.arrayContaining(["valid", "ahead"]));
    expect(sessions.map((item) => item.sessionId)).not.toContain("corrupt-json");
    expect(sessions.map((item) => item.sessionId)).not.toContain("invalid-meta");
  });

  it("rejects V2 record envelopes, session substitution, and sequence discontinuity", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-records-${Date.now()}-${Math.random()}`);
    const legacy = new V2ReadOnlySessionStore(root);
    const rewriteFirst = async (
      sessionId: string,
      transform: (value: LegacyAgentEventEnvelopeV2) => LegacyAgentEventEnvelopeV2
    ): Promise<void> => {
      await writeLegacySession(root, sessionId, 1);
      const file = path.join(legacySessionDirectoryV2(root, sessionId), "events", "000001.jsonl");
      const stored = JSON.parse((await readFile(file, "utf8")).trim()) as { event: LegacyAgentEventEnvelopeV2 };
      const changed = transform(stored.event);
      const checksum = createHash("sha256").update(JSON.stringify(changed)).digest("hex");
      await writeFile(file, `${JSON.stringify({ checksum, event: changed })}\n`, "utf8");
    };
    const consume = async (sessionId: string): Promise<void> => {
      for await (const _event of legacy.events(sessionId)) { /* validate the immutable stream */ }
    };

    await rewriteFirst("wrong-session", (value) => ({ ...value, sessionId: "substituted" }));
    await expect(legacy.inspect("wrong-session")).rejects.toThrow("session mismatch");
    await expect(consume("wrong-session")).rejects.toThrow("session mismatch");

    await rewriteFirst("wrong-sequence", (value) => ({ ...value, seq: 2 }));
    await expect(legacy.inspect("wrong-sequence")).rejects.toThrow("sequence discontinuity");
    await expect(consume("wrong-sequence")).rejects.toThrow("sequence discontinuity");

    await writeLegacySession(root, "bad-envelope", 1);
    const malformed = path.join(legacySessionDirectoryV2(root, "bad-envelope"), "events", "000001.jsonl");
    await writeFile(malformed, `${JSON.stringify({ checksum: "digest" })}\n`, "utf8");
    await expect(legacy.inspect("bad-envelope")).rejects.toThrow("Invalid V2 event record envelope");
  });

  it("fails closed across migration preflight, snapshot replay, and source-stability checks", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-fail-closed-${Date.now()}-${Math.random()}`);
    const snapshot = (sessionId: string, seq: number) => ({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId,
      seq,
      createdAt: "2026-01-02T00:00:00.000Z",
      state: { rebuilt: true }
    });

    await writeLegacySession(root, "empty", 0);
    await expect(promoteV2Session({ rootDir: root, sessionId: "empty", rebuildSnapshot: async () => snapshot("empty", 0) }))
      .rejects.toThrow("Cannot promote empty");

    await writeLegacySession(root, "invalid-limit", 1);
    await expect(promoteV2Session({
      rootDir: root, sessionId: "invalid-limit", segmentEvents: 0,
      rebuildSnapshot: async () => snapshot("invalid-limit", 1)
    })).rejects.toThrow("segment limits must be positive");

    await writeLegacySession(root, "wrong-snapshot", 1);
    await expect(promoteV2Session({
      rootDir: root, sessionId: "wrong-snapshot",
      rebuildSnapshot: async () => snapshot("different-session", 1)
    })).rejects.toThrow("does not match promoted session");

    await writeLegacySession(root, "changed-source", 1);
    const changedMetaPath = path.join(legacySessionDirectoryV2(root, "changed-source"), "meta.json");
    await expect(promoteV2Session({
      rootDir: root,
      sessionId: "changed-source",
      rebuildSnapshot: async () => {
        const meta = JSON.parse(await readFile(changedMetaPath, "utf8")) as Record<string, unknown>;
        await writeFile(changedMetaPath, `${JSON.stringify({ ...meta, updatedAt: "2026-01-03T00:00:00.000Z" })}\n`, "utf8");
        return snapshot("changed-source", 1);
      }
    })).rejects.toThrow("source changed while promoting");

    await writeLegacySession(root, "changed-after-publish", 1);
    await expect(promoteV2Session({
      rootDir: root,
      sessionId: "changed-after-publish",
      rebuildSnapshot: async () => snapshot("changed-after-publish", 1),
      afterPublish: async () => await writeLegacySession(root, "changed-after-publish", 2)
    })).rejects.toThrow("source changed while promoting");
    await expect(readFile(path.join(sessionDirectory(root, "changed-after-publish"), "meta.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    await writeLegacySession(root, "active-source", 1);
    await writeFile(path.join(legacySessionDirectoryV2(root, "active-source"), ".append.lock"), `${JSON.stringify({
      pid: process.pid,
      instanceId: "active-v2-writer",
      startedAt: new Date().toISOString()
    })}\n`);
    await expect(promoteV2Session({
      rootDir: root,
      sessionId: "active-source",
      rebuildSnapshot: async () => snapshot("active-source", 1)
    })).rejects.toMatchObject({ code: "v2_source_active" });

    await writeLegacySession(root, "invalid-target", 1);
    await mkdir(sessionDirectory(root, "invalid-target"), { recursive: true });
    await writeFile(path.join(sessionDirectory(root, "invalid-target"), "meta.json"), "{}\n", "utf8");
    await expect(promoteV2Session({ rootDir: root, sessionId: "invalid-target" }))
      .rejects.toThrow("target already exists but is invalid");

    await writeLegacySession(root, "target-without-meta", 1);
    await mkdir(sessionDirectory(root, "target-without-meta"), { recursive: true });
    await expect(promoteV2Session({ rootDir: root, sessionId: "target-without-meta" }))
      .rejects.toThrow("target already exists but is invalid");

    await writeLegacySession(root, "aborted", 1);
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled migration"));
    await expect(promoteV2Session({ rootDir: root, sessionId: "aborted", signal: controller.signal }))
      .rejects.toThrow("operator cancelled migration");
  });

  it("cleans stale staging and honors explicit segmentation during promotion", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-segmented-${Date.now()}-${Math.random()}`);
    await writeLegacySession(root, "segmented", 3);
    const v3Root = path.dirname(sessionsDirectory(root));
    const stale = path.join(v3Root, ".promotion-segmented-stale");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "partial"), "partial", "utf8");
    await expect(promoteV2Session({
      rootDir: root, sessionId: "segmented", dryRun: true,
      rebuildSnapshot: async () => { throw new Error("dry run must not replay"); }
    })).resolves.toMatchObject({ status: "dry_run", snapshot: "rebuilt" });
    await expect(readFile(path.join(stale, "partial"))).rejects.toMatchObject({ code: "ENOENT" });

    const result = await promoteV2Session({
      rootDir: root,
      sessionId: "segmented",
      segmentEvents: 1,
      segmentBytes: 1_000_000,
      signal: new AbortController().signal,
      replaceFile: async (source, target) => await rename(source, target),
      rebuildSnapshot: async ({ sessionId, lastSeq }) => ({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        storeLayoutVersion: STORE_LAYOUT_VERSION,
        sessionId,
        seq: lastSeq,
        createdAt: "2026-01-02T00:00:00.000Z",
        state: { rebuilt: true }
      })
    });
    expect(result.status).toBe("promoted");
    expect(await readdir(path.join(sessionDirectory(root, "segmented"), "events")))
      .toEqual(["000001.jsonl", "000002.jsonl", "000003.jsonl"]);
  });

  it("resolves an atomic publish race only when the competing V3 target is valid", async () => {
    const root = path.join(os.tmpdir(), `sigma-v2-publish-race-${Date.now()}-${Math.random()}`);
    await writeLegacySession(root, "publish-race", 1);
    const result = await promoteV2Session({
      rootDir: root,
      sessionId: "publish-race",
      rebuildSnapshot: async ({ sessionId, lastSeq }) => {
        const competing = new SegmentedJsonlStore({ rootDir: root });
        await competing.append(event(sessionId, 1, "session.created"), 0);
        return {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          storeLayoutVersion: STORE_LAYOUT_VERSION,
          sessionId,
          seq: lastSeq,
          createdAt: "2026-01-02T00:00:00.000Z",
          state: { rebuilt: true }
        };
      }
    });
    expect(result).toMatchObject({ status: "already_v3", sessionId: "publish-race" });
    const competing = new SegmentedJsonlStore({ rootDir: root });
    const stored: AgentEventEnvelope[] = [];
    for await (const item of competing.events("publish-race")) stored.push(item);
    expect(stored).toHaveLength(1);
  });
});
