import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { rebuildV3SnapshotFromEvents } from "../packages/agent-runtime/dist/index.js";
import {
  legacySessionDirectoryV2,
  promoteV2Session,
  SegmentedJsonlStore
} from "../packages/agent-store/dist/index.js";

const EVENT_COUNT = 100_000;
const EVENTS_PER_SEGMENT = 1_000;
const SESSION_ID = "migration-100k";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const OUTPUT_PATH = path.resolve(process.env.SIGMA_PERF_OUTPUT ?? ".artifacts/migration-v2-100k.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function event(seq, workspace) {
  return {
    schemaVersion: 2,
    seq,
    eventId: `event-${seq}`,
    sessionId: SESSION_ID,
    runId: "run",
    occurredAt: new Date(BASE_TIME + seq).toISOString(),
    type: seq === 1 ? "session.created" : "diagnostic",
    authority: "runtime",
    payload: seq === 1
      ? { workspacePath: workspace, mode: "change" }
      : { kind: "migration_scale_fixture", seq }
  };
}

async function writeLegacyFixture(root) {
  const session = legacySessionDirectoryV2(root, SESSION_ID);
  const events = path.join(session, "events");
  await mkdir(events, { recursive: true });
  let seq = 0;
  let segment = 0;
  while (seq < EVENT_COUNT) {
    segment += 1;
    const lines = [];
    for (let index = 0; index < EVENTS_PER_SEGMENT && seq < EVENT_COUNT; index += 1) {
      seq += 1;
      const value = event(seq, root);
      lines.push(JSON.stringify({ checksum: sha256(JSON.stringify(value)), event: value }));
    }
    await writeFile(path.join(events, `${String(segment).padStart(6, "0")}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }
  const createdAt = new Date(BASE_TIME + 1).toISOString();
  const updatedAt = new Date(BASE_TIME + EVENT_COUNT).toISOString();
  await writeFile(path.join(session, "meta.json"), `${JSON.stringify({
    schemaVersion: 2,
    sessionId: SESSION_ID,
    createdAt,
    updatedAt,
    lastSeq: EVENT_COUNT,
    segment,
    segmentEvents: EVENTS_PER_SEGMENT
  })}\n`, "utf8");
}

async function sourceFingerprint(root) {
  const session = legacySessionDirectoryV2(root, SESSION_ID);
  const hash = createHash("sha256");
  for (const relative of ["meta.json", ...((await readdir(path.join(session, "events"))).sort()
    .map((name) => path.join("events", name)))]) {
    hash.update(relative.replaceAll(path.sep, "/"));
    hash.update(await readFile(path.join(session, relative)));
  }
  return hash.digest("hex");
}

async function verifyTarget(root) {
  const store = new SegmentedJsonlStore({ rootDir: root });
  let count = 0;
  for await (const value of store.events(SESSION_ID)) {
    count += 1;
    if (value.seq !== count) throw new Error(`Target sequence mismatch at ${count}.`);
  }
  const snapshot = await store.latestSnapshot(SESSION_ID);
  if (count !== EVENT_COUNT || snapshot?.seq !== EVENT_COUNT) {
    throw new Error(`Target verification failed: events=${count}, snapshot=${String(snapshot?.seq)}.`);
  }
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-v2-migration-100k-"));
  try {
    await writeLegacyFixture(root);
    const sourceBefore = await sourceFingerprint(root);
    globalThis.gc?.();
    let peakRss = process.memoryUsage().rss;
    const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    const started = performance.now();
    const result = await promoteV2Session({
      rootDir: root,
      sessionId: SESSION_ID,
      rebuildSnapshot: rebuildV3SnapshotFromEvents
    });
    const elapsedMs = Math.round(performance.now() - started);
    clearInterval(sample);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await verifyTarget(root);
    const sourceAfter = await sourceFingerprint(root);
    const peakMiB = peakRss / 1024 / 1024;
    const report = {
      schemaVersion: 1,
      kind: "v2Migration100k",
      ok: result.status === "promoted" && sourceBefore === sourceAfter && peakMiB < 256,
      events: EVENT_COUNT,
      elapsedMs,
      peakRssMiB: Number(peakMiB.toFixed(2)),
      sourceUnchanged: sourceBefore === sourceAfter,
      snapshot: result.snapshot
    };
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    if (process.env.SIGMA_KEEP_PERF_FIXTURE !== "1") await rm(root, { recursive: true, force: true });
  }
}

await main();
