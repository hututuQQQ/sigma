import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  assertSnapshotEnvelope,
  upcastAgentEventV2,
  type AgentEventEnvelope
} from "agent-protocol";
import { atomicJson } from "./durable-file.js";
import { V2ReadOnlySessionStore, type LegacySessionInspectionV2 } from "./legacy-v2-store.js";
import type { PromoteV2SessionOptions, PromotionSnapshotStatus } from "./migration-contract.js";
import { segmentName, sessionDirectory } from "./paths.js";
import { SegmentedJsonlStore } from "./segmented-jsonl-store.js";

const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEGMENT_EVENTS = 10_000;

export interface PromotionCopyContext {
  sessionId: string;
  legacy: V2ReadOnlySessionStore;
}

export function targetStoreOptions(
  options: PromoteV2SessionOptions,
  temporaryRoot: string
): ConstructorParameters<typeof SegmentedJsonlStore>[0] {
  return {
    rootDir: temporaryRoot,
    ...(options.segmentBytes === undefined ? {} : { segmentBytes: options.segmentBytes }),
    ...(options.segmentEvents === undefined ? {} : { segmentEvents: options.segmentEvents }),
    ...(options.replaceFile === undefined ? {} : { replaceFile: options.replaceFile })
  };
}

function promotedLine(event: AgentEventEnvelope): string {
  const checksum = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return `${JSON.stringify({ checksum, event })}\n`;
}

interface LegacyReplayCursor {
  revision: number;
  terminal: boolean;
}

function promotionEvent(
  legacyEvent: Parameters<typeof upcastAgentEventV2>[0],
  cursor: LegacyReplayCursor
): AgentEventEnvelope {
  if (legacyEvent.type === "run.started" && cursor.terminal) {
    cursor.revision = 0;
    cursor.terminal = false;
  }
  cursor.revision += 1;
  const event = upcastAgentEventV2(legacyEvent);
  if (event.type === "run.completed" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    event.payload = { ...event.payload, outcomeRevision: cursor.revision - 1 };
  }
  if (event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed") {
    cursor.terminal = true;
  }
  return event;
}

export async function copyLegacyEvents(
  options: PromoteV2SessionOptions,
  context: PromotionCopyContext,
  source: LegacySessionInspectionV2,
  temporaryRoot: string,
  signal?: AbortSignal
): Promise<void> {
  const maximumBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
  const maximumEvents = options.segmentEvents ?? DEFAULT_SEGMENT_EVENTS;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || !Number.isSafeInteger(maximumEvents) || maximumEvents < 1) {
    throw new Error("Promotion segment limits must be positive safe integers.");
  }
  const directory = sessionDirectory(temporaryRoot, context.sessionId);
  const eventsDirectory = path.join(directory, "events");
  await mkdir(eventsDirectory, { recursive: true });
  let expectedSeq = 0;
  let segment = 1;
  let segmentEvents = 0;
  let segmentBytes = 0;
  const cursor: LegacyReplayCursor = { revision: 0, terminal: false };
  let handle = await open(path.join(eventsDirectory, segmentName(segment)), "wx");
  try {
    for await (const legacyEvent of context.legacy.events(context.sessionId)) {
      signal?.throwIfAborted();
      const event = promotionEvent(legacyEvent, cursor);
      if (event.seq !== expectedSeq + 1) {
        throw new Error(`Promoted event sequence discontinuity: expected ${expectedSeq + 1}, actual ${event.seq}.`);
      }
      const line = promotedLine(event);
      const lineBytes = Buffer.byteLength(line);
      if (segmentEvents > 0 && (segmentEvents >= maximumEvents || segmentBytes + lineBytes > maximumBytes)) {
        await handle.sync();
        await handle.close();
        segment += 1;
        segmentEvents = 0;
        segmentBytes = 0;
        handle = await open(path.join(eventsDirectory, segmentName(segment)), "wx");
      }
      await handle.write(line, undefined, "utf8");
      segmentEvents += 1;
      segmentBytes += lineBytes;
      expectedSeq = event.seq;
    }
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (expectedSeq !== source.lastSeq) {
    throw new Error(`V2 source changed while promoting '${context.sessionId}': expected seq ${source.lastSeq}, actual ${expectedSeq}.`);
  }
  await atomicJson(path.join(directory, "meta.json"), {
    schemaVersion: STORE_LAYOUT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId: source.sessionId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    lastSeq: expectedSeq,
    segment,
    segmentEvents
  }, options.replaceFile);
}

export async function rebuildTargetSnapshot(
  options: PromoteV2SessionOptions,
  source: LegacySessionInspectionV2,
  targetStore: SegmentedJsonlStore
): Promise<{ status: PromotionSnapshotStatus; snapshot: Awaited<ReturnType<NonNullable<PromoteV2SessionOptions["rebuildSnapshot"]>>> }> {
  if (!options.rebuildSnapshot) {
    throw new Error("V2 promotion requires a V3 event replayer; legacy snapshots are never reused.");
  }
  const rebuilt = await options.rebuildSnapshot({
    sessionId: source.sessionId,
    lastSeq: source.lastSeq,
    events: () => targetStore.events(source.sessionId)
  });
  assertSnapshotEnvelope(rebuilt);
  if (rebuilt.sessionId !== source.sessionId || rebuilt.seq !== source.lastSeq) {
    throw new Error(`Rebuilt V3 snapshot does not match promoted session '${source.sessionId}' at seq ${source.lastSeq}.`);
  }
  await targetStore.writeSnapshot(rebuilt);
  return { status: "rebuilt", snapshot: rebuilt };
}
