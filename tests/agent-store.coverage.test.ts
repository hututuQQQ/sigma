import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import {
  ContentAddressedArtifactStore,
  JsonlEvaluationSink,
  safeId,
  segmentName,
  SegmentedJsonlStore,
  sessionDirectory,
  snapshotName
} from "../packages/agent-store/src/index.js";

function event(sessionId: string, seq: number, type: AgentEventEnvelope["type"] = "diagnostic"): AgentEventEnvelope {
  return {
    schemaVersion: 2,
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

describe("agent-store crash and validation coverage", () => {
  it("stores content-addressed artifacts idempotently and validates identifiers", async () => {
    const actualRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-artifacts-"));
    const artifacts = new ContentAddressedArtifactStore(actualRoot);
    const digest = await artifacts.put("session", "hello");
    expect(await artifacts.put("session", new TextEncoder().encode("hello"))).toBe(digest);
    expect((await artifacts.get("session", digest)).toString("utf8")).toBe("hello");
    await expect(artifacts.get("session", "bad")).rejects.toThrow("Invalid artifact digest");
    for (const invalid of [".", "..", "x".repeat(129), "path/escape"]) expect(() => safeId(invalid)).toThrow("Unsafe");
    expect(safeId("valid.session-1")).toBe("valid.session-1");
    expect(sessionDirectory(actualRoot, "session")).toContain(path.join("sessions-v2", "session"));
    expect(segmentName(3)).toBe("000003.jsonl");
    expect(snapshotName(12)).toBe("000000000012.json");
    await rm(actualRoot, { recursive: true, force: true });
  });

  it("rotates segments, filters replay, and rejects sequence conflicts", async () => {
    const root = path.join(os.tmpdir(), `sigma-segments-${Date.now()}-${Math.random()}`);
    const store = new SegmentedJsonlStore({ rootDir: root, segmentEvents: 1, segmentBytes: 1_000_000 });
    expect(await store.append(event("rotate", 1, "session.created"), 0)).toEqual({ rotated: false });
    expect(await store.append(event("rotate", 2), 1)).toEqual({ rotated: true });
    expect((await readdir(path.join(root, "sessions-v2", "rotate", "events"))).sort()).toEqual(["000001.jsonl", "000002.jsonl"]);
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
    const eventPath = path.join(root, "sessions-v2", "tail", "events", "000001.jsonl");
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
          const durable = await readFile(path.join(root, "sessions-v2", "meta-crash", "events", "000001.jsonl"), "utf8");
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
    const directory = path.join(root, "sessions-v2", "meta-retry");
    const meta = JSON.parse(await readFile(path.join(directory, "meta.json"), "utf8")) as { lastSeq: number };
    expect(meta.lastSeq).toBe(1);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("detects durable corruption and recovers stale locks", async () => {
    const root = path.join(os.tmpdir(), `sigma-corruption-${Date.now()}-${Math.random()}`);
    const store = new SegmentedJsonlStore({ rootDir: root });
    await store.append(event("corrupt", 1, "session.created"), 0);
    const directory = path.join(root, "sessions-v2", "corrupt");
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
    await store.writeSnapshot({ schemaVersion: 2, sessionId: "snap", seq: 1, createdAt: "one", state: { value: 1 } });
    await store.writeSnapshot({ schemaVersion: 2, sessionId: "snap", seq: 2, createdAt: "two", state: { value: 2 } });
    const latest = path.join(root, "sessions-v2", "snap", "snapshots", snapshotName(2));
    await writeFile(latest, "{corrupt", "utf8");
    await expect(store.latestSnapshot("snap")).resolves.toMatchObject({ seq: 1, state: { value: 1 } });

    await mkdir(path.join(root, "sessions-v2", "invalid"), { recursive: true });
    await writeFile(path.join(root, "sessions-v2", "invalid", "meta.json"), "bad", "utf8");
    await store.append({ ...event("newer", 1, "session.created"), occurredAt: "2099-01-01T00:00:00.000Z" }, 0);
    expect((await store.listSessions()).map((item) => item.sessionId)).toEqual(["newer", "snap"]);

    const sink = new JsonlEvaluationSink(root);
    await sink.append({ schemaVersion: 1, reportId: "one", occurredAt: "now", evaluator: "human", payload: { score: 1 } });
    await sink.append({ schemaVersion: 1, reportId: "two", occurredAt: "later", evaluator: "human", payload: null });
    const reports = (await readFile(path.join(root, "evaluation-reports", "reports.jsonl"), "utf8")).trim().split("\n");
    expect(reports).toHaveLength(2);
    expect(await store.listSessions()).toHaveLength(2);
  });
});
