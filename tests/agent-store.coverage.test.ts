import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type AgentEventEnvelope
} from "../packages/agent-protocol/src/index.js";
import {
  ContentAddressedArtifactStore,
  JsonlEvaluationSink,
  legacySessionDirectoryV2,
  legacySessionDirectoryV3,
  safeId,
  segmentName,
  SegmentedJsonlStore,
  sessionDirectory,
  sessionsDirectory,
  snapshotName
} from "../packages/agent-store/src/index.js";

function event(sessionId: string, seq: number, type: "session.created" | "diagnostic" = "diagnostic"): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: `${sessionId}-${seq}`,
    sessionId,
    runId: "run",
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    type,
    authority: "runtime",
    payload: type === "session.created" ? {
      workspacePath: "D:/workspace", mode: "change", title: "task", writeScope: ["."],
      strictWriteScope: true, modelRole: "orchestrator"
    } : { kind: "recovery.retry_model", message: `diagnostic ${seq}` }
  };
}

describe("agent-store V5 durability", () => {
  it.skipIf(process.platform === "win32")("creates owner-only state directories", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "sigma-private-store-"));
    const root = path.join(parent, "state");
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("private", 1, "session.created") as never, 0);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(sessionDirectory(root, "private"))).mode & 0o777).toBe(0o700);
  });

  it("stores content-addressed artifacts and validates identifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-artifacts-"));
    const artifacts = new ContentAddressedArtifactStore(root);
    const digest = await artifacts.put("session", "hello");
    expect(await artifacts.put("session", new TextEncoder().encode("hello"))).toBe(digest);
    expect((await artifacts.get("session", digest)).toString("utf8")).toBe("hello");
    await expect(artifacts.get("session", "bad")).rejects.toThrow("Invalid artifact digest");
    await writeFile(path.join(sessionDirectory(root, "session"), "artifacts", digest), "corrupt");
    await expect(artifacts.get("session", digest)).rejects.toThrow("Artifact CAS object");
    for (const invalid of [".", "..", "x".repeat(129), "path/escape"]) expect(() => safeId(invalid)).toThrow();
    expect(segmentName(3)).toBe("000003.jsonl");
    expect(snapshotName(12)).toBe("000000000012.json");
    await rm(root, { recursive: true, force: true });
  });

  it("rotates, filters replay, and rejects sequence conflicts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-segments-"));
    const store = new SegmentedJsonlStore({ rootDir: root, segmentEvents: 1, segmentBytes: 1_000_000 });
    expect(await store.append(event("rotate", 1, "session.created") as never, 0)).toEqual({ rotated: false });
    expect(await store.append(event("rotate", 2) as never, 1)).toEqual({ rotated: true });
    expect(await readdir(path.join(sessionDirectory(root, "rotate"), "events")))
      .toEqual(["000001.jsonl", "000002.jsonl"]);
    const replay: number[] = [];
    for await (const item of store.events("rotate", 1)) replay.push(item.seq);
    expect(replay).toEqual([2]);
    await expect(store.append(event("rotate", 4) as never, 2)).rejects.toThrow("must equal 3");
    await expect(store.append(event("rotate", 3) as never, 1)).rejects.toThrow("sequence conflict");
  });

  it("repairs a torn durable tail only while appending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-tail-"));
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("tail", 1, "session.created") as never, 0);
    const eventPath = path.join(sessionDirectory(root, "tail"), "events", "000001.jsonl");
    const complete = await readFile(eventPath, "utf8");
    await writeFile(eventPath, complete.trimEnd(), "utf8");
    expect((await readFile(eventPath, "utf8")).endsWith("\n")).toBe(false);
    await store.append(event("tail", 2) as never, 1);
    await writeFile(eventPath, `${await readFile(eventPath, "utf8")}{"broken"`, "utf8");
    await store.append(event("tail", 3) as never, 2);
    const replay: number[] = [];
    for await (const item of store.events("tail")) replay.push(item.seq);
    expect(replay).toEqual([1, 2, 3]);
  });

  it("reconciles a durable event after metadata replacement fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-meta-crash-"));
    let armed = false;
    let failed = false;
    const store = new SegmentedJsonlStore({
      rootDir: root,
      replaceFile: async (source, target) => {
        if (armed && !failed && target.endsWith("meta.json")) {
          failed = true;
          throw Object.assign(new Error("injected metadata failure"), { code: "EIO" });
        }
        await rename(source, target);
      }
    });
    await store.append(event("crash", 1, "session.created") as never, 0);
    armed = true;
    await expect(store.append(event("crash", 2) as never, 1)).rejects.toThrow("injected metadata failure");
    const recovered = new SegmentedJsonlStore({ rootDir: root });
    await expect(recovered.append(event("crash", 2) as never, 1)).rejects.toThrow("actual 2");
    await recovered.append(event("crash", 3) as never, 2);
  });

  it("rejects checksummed event corruption through the shared V5 schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-corruption-"));
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("corrupt", 1, "session.created") as never, 0);
    const directory = sessionDirectory(root, "corrupt");
    const lock = path.join(directory, ".append.lock");
    await writeFile(lock, "stale", "utf8");
    const old = new Date(Date.now() - 180_000);
    await utimes(lock, old, old);
    await store.append(event("corrupt", 2) as never, 1);
    const eventPath = path.join(directory, "events", "000001.jsonl");
    const lines = (await readFile(eventPath, "utf8")).trimEnd().split("\n");
    const record = JSON.parse(lines[0]!) as { event: AgentEventEnvelope };
    const changed = { ...record.event, payload: { ...record.event.payload as object, unexpected: true } };
    lines[0] = JSON.stringify({ checksum: createHash("sha256").update(JSON.stringify(changed)).digest("hex"), event: changed });
    await writeFile(eventPath, `${lines.join("\n")}\n`, "utf8");
    const consume = async (): Promise<void> => { for await (const _item of store.events("corrupt")) { /* validate */ } };
    await expect(consume()).rejects.toThrow("payload");
  });

  it("falls back across corrupt snapshots and isolates evaluation reports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-snapshots-"));
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("snap", 1, "session.created") as never, 0);
    for (const seq of [1, 2]) await store.writeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId: "snap", seq, createdAt: new Date(1_700_000_000_000 + seq).toISOString(), state: { seq }
    });
    await writeFile(path.join(sessionDirectory(root, "snap"), "snapshots", snapshotName(2)), "{corrupt", "utf8");
    await expect(store.latestSnapshot("snap")).resolves.toMatchObject({ seq: 1 });
    const sink = new JsonlEvaluationSink(root);
    await sink.append({ schemaVersion: 1, reportId: "one", occurredAt: "now", evaluator: "human", payload: null });
    expect(await store.listSessions()).toHaveLength(1);
  });

  it("uses stores/v5 while preserving V2, V3, and V4 directories byte-for-byte", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-versioned-store-"));
    const legacyFiles = [
      path.join(legacySessionDirectoryV2(root, "old-v2"), "meta.json"),
      path.join(legacySessionDirectoryV3(root, "old-v3"), "meta.json"),
      path.join(root, "stores", "v4", "sessions", "old-v4", "meta.json")
    ];
    for (const file of legacyFiles) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "legacy bytes\n", "utf8");
    }
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("new-v5", 1, "session.created") as never, 0);
    expect(sessionDirectory(root, "new-v5")).toContain(path.join("stores", "v5", "sessions"));
    for (const file of legacyFiles) expect(await readFile(file, "utf8")).toBe("legacy bytes\n");
    expect(await readdir(sessionsDirectory(root))).toEqual(["new-v5"]);
  });
});
