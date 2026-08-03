import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { acquireProcessOwnerLease } from "agent-platform";
import {
  EVENT_SCHEMA_VERSION,
  assertAgentEventEnvelope,
  type AnyTypedAgentEvent,
  type StoreAppendResult
} from "agent-protocol";
import { atomicJson, type AtomicReplace } from "./durable-file.js";
import { inspectDurableEventTail } from "./durable-tail.js";
import { segmentName, sessionDirectory } from "./paths.js";
import { type SessionMeta } from "./segmented-store-formats.js";
import { unsupportedSchemaVersion } from "./schema-error.js";

interface StoredRecord {
  checksum: string;
  event: AnyTypedAgentEvent;
}

interface SegmentWrite {
  path: string;
  content: string;
}

interface SegmentWritePlan {
  writes: SegmentWrite[];
  segment: number;
  segmentEvents: number;
  rotated: boolean;
}

export interface AppendEventBatchOptions {
  rootDir: string;
  segmentBytes: number;
  segmentEvents: number;
  replaceFile?: AtomicReplace;
  events: readonly AnyTypedAgentEvent[];
  expectedSeq: number;
  readMeta(sessionId: string, now: string): Promise<SessionMeta>;
  reconcileMeta(sessionId: string, now: string): Promise<SessionMeta>;
}

function checksum(event: AnyTypedAgentEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function storedLine(event: AnyTypedAgentEvent): string {
  return `${JSON.stringify({ checksum: checksum(event), event } satisfies StoredRecord)}\n`;
}

export function parseStoredEventRecord(
  line: string,
  sourcePath = "<event record>"
): AnyTypedAgentEvent {
  const parsed = JSON.parse(line) as StoredRecord;
  if (!parsed || typeof parsed !== "object" || !parsed.event || typeof parsed.checksum !== "string") {
    throw new Error("Invalid event record envelope.");
  }
  const actual = (parsed.event as { schemaVersion?: unknown }).schemaVersion;
  if (actual !== EVENT_SCHEMA_VERSION) {
    throw unsupportedSchemaVersion("event", sourcePath, EVENT_SCHEMA_VERSION, actual);
  }
  assertAgentEventEnvelope(parsed.event);
  if (checksum(parsed.event) !== parsed.checksum) {
    throw new Error(`Event checksum mismatch at seq ${parsed.event.seq}.`);
  }
  return parsed.event;
}

async function acquireSessionLock(directory: string): Promise<() => Promise<void>> {
  const lease = await acquireProcessOwnerLease(path.join(directory, ".append.lock"), {
    pid: process.pid,
    instanceId: randomUUID(),
    startedAt: new Date().toISOString()
  }, {
    label: "session append lock",
    timeoutMs: 10_000,
    malformedStaleMs: 5_000,
    retryIntervalMs: 10,
    activeOwner: "wait"
  });
  return lease.release;
}

function assertBatchSequence(
  events: readonly AnyTypedAgentEvent[],
  expectedSeq: number
): void {
  for (const [index, event] of events.entries()) {
    const required = expectedSeq + index + 1;
    if (event.seq !== required) throw new Error(`Event seq ${event.seq} must equal ${required}.`);
  }
}

async function planSegmentWrites(
  directory: string,
  meta: SessionMeta,
  events: readonly AnyTypedAgentEvent[],
  limits: { bytes: number; events: number }
): Promise<SegmentWritePlan> {
  let segment = meta.segment;
  let segmentEvents = meta.segmentEvents;
  let segmentPath = path.join(directory, "events", segmentName(segment));
  let segmentSize = await stat(segmentPath).then((item) => item.size, () => 0);
  let rotated = false;
  const writes: SegmentWrite[] = [];
  let pending = "";
  for (const event of events) {
    const line = storedLine(event);
    const bytes = Buffer.byteLength(line);
    if (segmentEvents >= limits.events || segmentSize + bytes > limits.bytes) {
      if (pending) writes.push({ path: segmentPath, content: pending });
      segment += 1;
      segmentEvents = 0;
      segmentSize = 0;
      segmentPath = path.join(directory, "events", segmentName(segment));
      pending = "";
      rotated = true;
    }
    pending += line;
    segmentEvents += 1;
    segmentSize += bytes;
  }
  if (pending) writes.push({ path: segmentPath, content: pending });
  return { writes, segment, segmentEvents, rotated };
}

async function appendSegmentWrites(writes: readonly SegmentWrite[]): Promise<void> {
  for (const write of writes) {
    const handle = await open(write.path, "a");
    try {
      await handle.write(write.content, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function appendEventBatch(
  options: AppendEventBatchOptions
): Promise<StoreAppendResult> {
  const first = options.events[0]!;
  const last = options.events.at(-1)!;
  const directory = sessionDirectory(options.rootDir, first.sessionId);
  await mkdir(path.join(directory, "events"), { recursive: true, mode: 0o700 });
  const release = await acquireSessionLock(directory);
  try {
    let meta = await options.readMeta(first.sessionId, first.occurredAt);
    const tail = await inspectDurableEventTail(
      directory,
      (line) => parseStoredEventRecord(line, directory)
    );
    if (meta.lastSeq !== options.expectedSeq || tail.incomplete
      || tail.lastSeq !== meta.lastSeq || tail.segment !== meta.segment) {
      meta = await options.reconcileMeta(first.sessionId, first.occurredAt);
    }
    if (meta.lastSeq !== options.expectedSeq) {
      throw new Error(
        `Session ${first.sessionId} sequence conflict: expected ${options.expectedSeq}, actual ${meta.lastSeq}.`
      );
    }
    assertBatchSequence(options.events, options.expectedSeq);
    const plan = await planSegmentWrites(directory, meta, options.events, {
      bytes: options.segmentBytes,
      events: options.segmentEvents
    });
    await appendSegmentWrites(plan.writes);
    await atomicJson(path.join(directory, "meta.json"), {
      ...meta,
      updatedAt: last.occurredAt,
      lastSeq: last.seq,
      segment: plan.segment,
      segmentEvents: plan.segmentEvents
    } satisfies SessionMeta, options.replaceFile);
    return { rotated: plan.rotated };
  } finally {
    await release();
  }
}
