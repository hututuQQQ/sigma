import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { acquireProcessOwnerLease } from "agent-platform";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  assertAgentEventEnvelope,
  assertSnapshotEnvelope
} from "agent-protocol";
import type {
  AnyTypedAgentEvent,
  ExternalEvaluationReport,
  EvaluationSink,
  RunStore,
  SnapshotEnvelope,
  StoreAppendResult
} from "agent-protocol";
import { atomicJson, type AtomicReplace } from "./durable-file.js";
import { inspectDurableEventTail } from "./durable-tail.js";
import { segmentName, sessionDirectory, sessionsDirectory, snapshotName } from "./paths.js";

const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEGMENT_EVENTS = 10_000;
export interface SessionMetaV5 {
  schemaVersion: typeof STORE_LAYOUT_VERSION;
  eventSchemaVersion: typeof EVENT_SCHEMA_VERSION;
  snapshotSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  segment: number;
  segmentEvents: number;
}

interface StoredRecord {
  checksum: string;
  event: AnyTypedAgentEvent;
}

interface StoredSnapshot {
  checksum: string;
  snapshot: SnapshotEnvelope;
}

interface EventCursor {
  lastValidSeq: number;
}

export interface SegmentedJsonlStoreOptions {
  rootDir: string;
  segmentBytes?: number;
  segmentEvents?: number;
  replaceFile?: AtomicReplace;
}

export function isSessionMetaV5(value: unknown, sessionId?: string): value is SessionMetaV5 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return [
    meta.schemaVersion === STORE_LAYOUT_VERSION,
    meta.eventSchemaVersion === EVENT_SCHEMA_VERSION,
    meta.snapshotSchemaVersion === SNAPSHOT_SCHEMA_VERSION,
    typeof meta.sessionId === "string" && meta.sessionId.length > 0,
    sessionId === undefined || meta.sessionId === sessionId,
    typeof meta.createdAt === "string" && Number.isFinite(Date.parse(meta.createdAt)),
    typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)),
    Number.isSafeInteger(meta.lastSeq) && Number(meta.lastSeq) >= 0,
    Number.isSafeInteger(meta.segment) && Number(meta.segment) >= 1,
    Number.isSafeInteger(meta.segmentEvents) && Number(meta.segmentEvents) >= 0
  ].every(Boolean);
}

function checksum(event: AnyTypedAgentEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function snapshotChecksum(snapshot: SnapshotEnvelope): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function storedLine(event: AnyTypedAgentEvent): string {
  return `${JSON.stringify({ checksum: checksum(event), event } satisfies StoredRecord)}\n`;
}

function parseRecord(line: string): AnyTypedAgentEvent {
  const parsed = JSON.parse(line) as StoredRecord;
  if (!parsed || typeof parsed !== "object" || !parsed.event || typeof parsed.checksum !== "string") {
    throw new Error("Invalid event record envelope.");
  }
  assertAgentEventEnvelope(parsed.event);
  if (checksum(parsed.event) !== parsed.checksum) throw new Error(`Event checksum mismatch at seq ${parsed.event.seq}.`);
  return parsed.event;
}

async function acquireSessionLock(directory: string): Promise<() => Promise<void>> {
  const lockPath = path.join(directory, ".append.lock");
  const lease = await acquireProcessOwnerLease(lockPath, {
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

export class SegmentedJsonlStore implements RunStore {
  private readonly rootDir: string;
  private readonly segmentBytes: number;
  private readonly segmentEvents: number;
  private readonly replaceFile: AtomicReplace | undefined;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: SegmentedJsonlStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
    this.segmentEvents = options.segmentEvents ?? DEFAULT_SEGMENT_EVENTS;
    this.replaceFile = options.replaceFile;
  }

  async append(event: AnyTypedAgentEvent, expectedSeq: number): Promise<StoreAppendResult> {
    assertAgentEventEnvelope(event);
    const previous = this.queues.get(event.sessionId) ?? Promise.resolve();
    const current = previous.then(() => this.appendLocked(event, expectedSeq));
    this.queues.set(event.sessionId, current.then(() => undefined, () => undefined));
    return await current;
  }

  private async appendLocked(event: AnyTypedAgentEvent, expectedSeq: number): Promise<StoreAppendResult> {
    const directory = sessionDirectory(this.rootDir, event.sessionId);
    await mkdir(path.join(directory, "events"), { recursive: true, mode: 0o700 });
    const release = await acquireSessionLock(directory);
    try {
    let meta = await this.readMeta(event.sessionId, event.occurredAt);
    const tail = await inspectDurableEventTail(directory, parseRecord);
    if (meta.lastSeq !== expectedSeq || tail.incomplete || tail.lastSeq !== meta.lastSeq || tail.segment !== meta.segment) {
      meta = await this.reconcileMeta(event.sessionId, event.occurredAt);
    }
    if (meta.lastSeq !== expectedSeq) throw new Error(`Session ${event.sessionId} sequence conflict: expected ${expectedSeq}, actual ${meta.lastSeq}.`);
    if (event.seq !== expectedSeq + 1) throw new Error(`Event seq ${event.seq} must equal ${expectedSeq + 1}.`);

    let segment = meta.segment;
    let segmentEvents = meta.segmentEvents;
    let segmentPath = path.join(directory, "events", segmentName(segment));
    const line = storedLine(event);
    const size = await stat(segmentPath).then((item) => item.size, () => 0);
    const rotated = segmentEvents >= this.segmentEvents || size + Buffer.byteLength(line) > this.segmentBytes;
    if (rotated) {
      segment += 1;
      segmentEvents = 0;
      segmentPath = path.join(directory, "events", segmentName(segment));
    }

    const handle = await open(segmentPath, "a");
    try {
      await handle.write(line, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicJson(path.join(directory, "meta.json"), {
      ...meta,
      updatedAt: event.occurredAt,
      lastSeq: event.seq,
      segment,
      segmentEvents: segmentEvents + 1
    } satisfies SessionMetaV5, this.replaceFile);
    return { rotated };
    } finally {
      await release();
    }
  }

  async *events(sessionId: string, afterSeq = 0, recoverTail = false): AsyncIterable<AnyTypedAgentEvent> {
    const eventsDir = path.join(sessionDirectory(this.rootDir, sessionId), "events");
    const files = (await readdir(eventsDir).catch(() => []))
      .filter((name) => /^\d{6}\.jsonl$/.test(name))
      .sort();
    const cursor: EventCursor = { lastValidSeq: 0 };
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const fileName = files[fileIndex];
      const lastSegment = fileIndex === files.length - 1;
      for await (const event of this.readSegmentEvents(sessionId, eventsDir, fileName, lastSegment, afterSeq, recoverTail, cursor)) {
        yield event;
      }
    }
  }

  private async *readSegmentEvents(
    sessionId: string,
    eventsDir: string,
    fileName: string,
    lastSegment: boolean,
    afterSeq: number,
    recoverTail: boolean,
    cursor: EventCursor
  ): AsyncIterable<AnyTypedAgentEvent> {
    const filePath = path.join(eventsDir, fileName);
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    let validBytes = 0;
    let validEvents = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex];
      const lineBytes = Buffer.byteLength(`${rawLine}${lineIndex < lines.length - 1 ? "\n" : ""}`);
      if (!rawLine.trim()) {
        validBytes += lineBytes;
        continue;
      }
      try {
        const event = parseRecord(rawLine.trim());
        if (event.seq !== cursor.lastValidSeq + 1) {
          throw new Error(`Event sequence discontinuity: expected ${cursor.lastValidSeq + 1}, actual ${event.seq}.`);
        }
        cursor.lastValidSeq = event.seq;
        validEvents += 1;
        validBytes += lineBytes;
        if (event.seq > afterSeq) yield event;
      } catch (error) {
        if (!this.isTornTail(lastSegment, lineIndex, lines.length, content)) throw error;
        if (recoverTail) {
          await this.truncateTornTail(sessionId, filePath, fileName, validBytes, validEvents, cursor.lastValidSeq);
        }
        return;
      }
    }
    if (recoverTail && lastSegment && content.length > 0 && !content.endsWith("\n")) {
      await this.appendNewline(filePath);
    }
  }

  private isTornTail(lastSegment: boolean, lineIndex: number, lineCount: number, content: string): boolean {
    return lastSegment && lineIndex === lineCount - 1 && !content.endsWith("\n");
  }

  private async appendNewline(filePath: string): Promise<void> {
    const handle = await open(filePath, "a");
    try {
      await handle.write("\n", undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async reconcileMeta(sessionId: string, now: string): Promise<SessionMetaV5> {
    let lastSeq = 0;
    for await (const event of this.events(sessionId, 0, true)) lastSeq = event.seq;
    const eventsDir = path.join(sessionDirectory(this.rootDir, sessionId), "events");
    const files = (await readdir(eventsDir).catch(() => [])).filter((name) => /^\d{6}\.jsonl$/.test(name)).sort();
    const segment = files.length > 0 ? Number.parseInt(files.at(-1)!.slice(0, 6), 10) : 1;
    const segmentEvents = files.length > 0
      ? (await readFile(path.join(eventsDir, files.at(-1)!), "utf8")).split("\n").filter((line) => line.trim()).length
      : 0;
    const meta = await this.readMeta(sessionId, now);
    const reconciled = { ...meta, updatedAt: now, lastSeq, segment, segmentEvents } satisfies SessionMetaV5;
    await atomicJson(path.join(sessionDirectory(this.rootDir, sessionId), "meta.json"), reconciled, this.replaceFile);
    return reconciled;
  }

  private async truncateTornTail(
    sessionId: string,
    filePath: string,
    fileName: string,
    validBytes: number,
    validEvents: number,
    lastValidSeq: number
  ): Promise<void> {
    const handle = await open(filePath, "r+");
    try {
      await handle.truncate(validBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const now = new Date().toISOString();
    const meta = await this.readMeta(sessionId, now);
    const segment = Number.parseInt(fileName.slice(0, 6), 10);
    await atomicJson(path.join(sessionDirectory(this.rootDir, sessionId), "meta.json"), {
      ...meta,
      updatedAt: now,
      lastSeq: lastValidSeq,
      segment,
      segmentEvents: validEvents
    } satisfies SessionMetaV5, this.replaceFile);
  }

  async writeSnapshot(snapshot: SnapshotEnvelope): Promise<void> {
    assertSnapshotEnvelope(snapshot);
    const directory = path.join(sessionDirectory(this.rootDir, snapshot.sessionId), "snapshots");
    await atomicJson(path.join(directory, snapshotName(snapshot.seq)), {
      checksum: snapshotChecksum(snapshot),
      snapshot
    } satisfies StoredSnapshot, this.replaceFile);
  }

  async latestSnapshot(sessionId: string): Promise<SnapshotEnvelope | null> {
    const directory = path.join(sessionDirectory(this.rootDir, sessionId), "snapshots");
    const files = (await readdir(directory).catch(() => []))
      .filter((name) => /^\d{12}\.json$/.test(name))
      .sort()
      .reverse();
    for (const file of files) {
      try {
        const stored = JSON.parse(await readFile(path.join(directory, file), "utf8")) as StoredSnapshot;
        assertSnapshotEnvelope(stored.snapshot);
        if (stored.snapshot.sessionId === sessionId && snapshotChecksum(stored.snapshot) === stored.checksum) {
          return stored.snapshot;
        }
      } catch {
        // A previous complete snapshot remains a valid recovery point.
      }
    }
    return null;
  }

  async listSessions(): Promise<Array<{ sessionId: string; updatedAt: string; lastSeq: number }>> {
    const root = sessionsDirectory(this.rootDir);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const sessions = await Promise.all(entries.filter((item) => item.isDirectory()).map(async (item) => {
      try {
        const meta = JSON.parse(await readFile(path.join(root, item.name, "meta.json"), "utf8")) as unknown;
        if (!isSessionMetaV5(meta, item.name)) return null;
        return { sessionId: meta.sessionId, updatedAt: meta.updatedAt, lastSeq: meta.lastSeq };
      } catch {
        return null;
      }
    }));
    return sessions.filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async readMeta(sessionId: string, now: string): Promise<SessionMetaV5> {
    const metaPath = path.join(sessionDirectory(this.rootDir, sessionId), "meta.json");
    try {
      const parsed = JSON.parse(await readFile(metaPath, "utf8")) as unknown;
      if (!isSessionMetaV5(parsed, sessionId)) throw new Error("invalid V5 metadata shape");
      return parsed;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        return {
          schemaVersion: STORE_LAYOUT_VERSION,
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
          sessionId,
          createdAt: now,
          updatedAt: now,
          lastSeq: 0,
          segment: 1,
          segmentEvents: 0
        };
      }
      throw new Error(`Session metadata is corrupt for '${sessionId}'.`, { cause: error });
    }
  }
}

export class JsonlEvaluationSink implements EvaluationSink {
  constructor(private readonly rootDir: string) {}

  async append(report: ExternalEvaluationReport): Promise<void> {
    const directory = path.join(path.resolve(this.rootDir), "evaluation-reports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(path.join(directory, "reports.jsonl"), "a");
    try {
      await handle.write(`${JSON.stringify(report)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
