import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION
} from "../packages/agent-protocol/dist/index.js";
import { rebuildSnapshotFromEvents } from "../packages/agent-runtime/dist/session-admin.js";
import { SegmentedJsonlStore, sessionDirectory } from "../packages/agent-store/dist/index.js";

const EVENT_COUNT = 100_000;
const EVENTS_PER_SEGMENT = 1_000;
const SESSION_ID = "replay-v5-100k";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const OUTPUT_PATH = path.resolve(process.env.SIGMA_PERF_OUTPUT ?? ".artifacts/replay-v5-100k.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function event(seq, workspace) {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: `event-${seq}`,
    sessionId: SESSION_ID,
    runId: "run",
    occurredAt: new Date(BASE_TIME + seq).toISOString(),
    type: seq === 1 ? "session.created" : "diagnostic",
    authority: "runtime",
    payload: seq === 1 ? {
      workspacePath: workspace,
      mode: "change",
      title: "V5 replay performance fixture",
      writeScope: ["."],
      strictWriteScope: true,
      modelRole: "orchestrator"
    } : {
      kind: "recovery.retry_model",
      message: `replay fixture ${seq}`
    }
  };
}

async function writeFixture(root) {
  const session = sessionDirectory(root, SESSION_ID);
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
  await writeFile(path.join(session, "meta.json"), `${JSON.stringify({
    schemaVersion: STORE_LAYOUT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    createdAt: new Date(BASE_TIME + 1).toISOString(),
    updatedAt: new Date(BASE_TIME + EVENT_COUNT).toISOString(),
    lastSeq: EVENT_COUNT,
    segment,
    segmentEvents: EVENTS_PER_SEGMENT
  })}\n`, "utf8");
}

async function replay(root) {
  const store = new SegmentedJsonlStore({ rootDir: root });
  const snapshot = await rebuildSnapshotFromEvents({
    sessionId: SESSION_ID,
    lastSeq: EVENT_COUNT,
    events: () => store.events(SESSION_ID)
  });
  await store.writeSnapshot(snapshot);
  const restored = await store.latestSnapshot(SESSION_ID);
  if (restored?.seq !== EVENT_COUNT) throw new Error("V5 snapshot reconstruction did not reach the event tail.");
  let count = 0;
  for await (const value of store.events(SESSION_ID, EVENT_COUNT - 10)) {
    count += 1;
    if (value.seq !== EVENT_COUNT - 10 + count) throw new Error("Segmented tail replay is discontinuous.");
  }
  if (count !== 10) throw new Error(`Expected 10 tail events, received ${count}.`);
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-v5-replay-100k-"));
  try {
    await writeFixture(root);
    globalThis.gc?.();
    let peakRss = process.memoryUsage().rss;
    const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    const started = performance.now();
    await replay(root);
    const elapsedMs = Math.round(performance.now() - started);
    clearInterval(sample);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const peakRssMiB = peakRss / 1024 / 1024;
    const report = {
      schemaVersion: 1,
      kind: "v5Replay100k",
      ok: peakRssMiB < 256,
      events: EVENT_COUNT,
      elapsedMs,
      peakRssMiB: Number(peakRssMiB.toFixed(2)),
      snapshotRebuilt: true
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
