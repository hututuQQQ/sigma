import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  LEGACY_EVENT_SCHEMA_VERSION_V2,
  LEGACY_STORE_LAYOUT_VERSION_V2,
  assertLegacyAgentEventEnvelopeV2,
  type LegacyAgentEventEnvelopeV2
} from "agent-protocol";
import { legacySessionDirectoryV2, legacySessionsDirectoryV2 } from "./paths.js";

interface LegacyStoredRecordV2 {
  checksum: string;
  event: LegacyAgentEventEnvelopeV2;
}

export interface LegacySessionMetaV2 {
  schemaVersion: typeof LEGACY_STORE_LAYOUT_VERSION_V2;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  segment: number;
  segmentEvents: number;
}

export interface LegacySegmentDigestV2 {
  name: string;
  digest: string;
  bytes: number;
}

export interface LegacySessionInspectionV2 {
  storeLayoutVersion: typeof LEGACY_STORE_LAYOUT_VERSION_V2;
  eventSchemaVersion: typeof LEGACY_EVENT_SCHEMA_VERSION_V2;
  sessionId: string;
  sourceDirectory: string;
  sourceDigest: string;
  metaDigest: string;
  segments: LegacySegmentDigestV2[];
  eventCount: number;
  lastSeq: number;
  metaLastSeq: number;
  incompleteTail: boolean;
  createdAt: string;
  updatedAt: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventChecksum(event: LegacyAgentEventEnvelopeV2): string {
  return sha256(JSON.stringify(event));
}

interface LegacyLine {
  line: string;
  terminated: boolean;
}

/** Read JSONL incrementally so a large legacy segment is never retained twice in memory. */
async function* legacyLines(filePath: string): AsyncIterable<LegacyLine> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const raw of createReadStream(filePath)) {
    pending += decoder.write(raw as Buffer);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      yield { line: line.endsWith("\r") ? line.slice(0, -1) : line, terminated: true };
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.end();
  if (pending) yield { line: pending, terminated: false };
}

async function digestFile(filePath: string): Promise<{ digest: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const raw of createReadStream(filePath)) {
    const chunk = raw as Buffer;
    bytes += chunk.byteLength;
    digest.update(chunk);
  }
  return { digest: digest.digest("hex"), bytes };
}

function decodeLegacyRecord(line: string): LegacyAgentEventEnvelopeV2 {
  const parsed = JSON.parse(line) as LegacyStoredRecordV2;
  if (!parsed || typeof parsed !== "object" || !parsed.event || typeof parsed.checksum !== "string") {
    throw new Error("Invalid V2 event record envelope.");
  }
  assertLegacyAgentEventEnvelopeV2(parsed.event);
  if (eventChecksum(parsed.event) !== parsed.checksum) {
    throw new Error(`V2 event checksum mismatch at seq ${parsed.event.seq}.`);
  }
  return parsed.event;
}

function isLegacyMeta(value: unknown, sessionId: string): value is LegacySessionMetaV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return meta.schemaVersion === LEGACY_STORE_LAYOUT_VERSION_V2 && meta.sessionId === sessionId
    && typeof meta.createdAt === "string" && Number.isFinite(Date.parse(meta.createdAt))
    && typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt))
    && Number.isSafeInteger(meta.lastSeq) && Number(meta.lastSeq) >= 0
    && Number.isSafeInteger(meta.segment) && Number(meta.segment) >= 1
    && Number.isSafeInteger(meta.segmentEvents) && Number(meta.segmentEvents) >= 0;
}

async function readLegacyMeta(rootDir: string, sessionId: string): Promise<{ meta: LegacySessionMetaV2; source: string }> {
  const metaPath = path.join(legacySessionDirectoryV2(rootDir, sessionId), "meta.json");
  let source: string;
  try {
    source = await readFile(metaPath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new Error(`V2 session '${sessionId}' does not exist.`, { cause: error });
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`V2 session metadata is corrupt for '${sessionId}'.`, { cause: error });
  }
  if (!isLegacyMeta(parsed, sessionId)) throw new Error(`Invalid V2 session metadata for '${sessionId}'.`);
  return { meta: parsed, source };
}

async function segmentFiles(rootDir: string, sessionId: string): Promise<string[]> {
  const eventsDir = path.join(legacySessionDirectoryV2(rootDir, sessionId), "events");
  return (await readdir(eventsDir).catch(() => []))
    .filter((name) => /^\d{6}\.jsonl$/u.test(name))
    .sort();
}

interface LegacyScanResult {
  eventCount: number;
  lastSeq: number;
  incompleteTail: boolean;
}

async function scanLegacyEvents(
  rootDir: string,
  sessionId: string,
  afterSeq: number,
  receive?: (event: LegacyAgentEventEnvelopeV2) => void | Promise<void>
): Promise<LegacyScanResult> {
  const eventsDir = path.join(legacySessionDirectoryV2(rootDir, sessionId), "events");
  const files = await segmentFiles(rootDir, sessionId);
  let eventCount = 0;
  let lastSeq = 0;
  let incompleteTail = false;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const filePath = path.join(eventsDir, files[fileIndex]!);
    for await (const record of legacyLines(filePath)) {
      const line = record.line;
      if (!line.trim()) continue;
      let event: LegacyAgentEventEnvelopeV2;
      try {
        event = decodeLegacyRecord(line.trim());
      } catch (error) {
        const tornFinalLine = fileIndex === files.length - 1 && !record.terminated;
        if (tornFinalLine) {
          incompleteTail = true;
          break;
        }
        throw error;
      }
      if (event.sessionId !== sessionId) throw new Error(`V2 event session mismatch at seq ${event.seq}.`);
      if (event.seq !== lastSeq + 1) {
        throw new Error(`V2 event sequence discontinuity: expected ${lastSeq + 1}, actual ${event.seq}.`);
      }
      lastSeq = event.seq;
      eventCount += 1;
      if (event.seq > afterSeq) await receive?.(event);
    }
  }
  return { eventCount, lastSeq, incompleteTail };
}

/** A deliberately read-only adapter for immutable V2 stores. */
export class V2ReadOnlySessionStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async *events(sessionId: string, afterSeq = 0): AsyncIterable<LegacyAgentEventEnvelopeV2> {
    const eventsDir = path.join(legacySessionDirectoryV2(this.rootDir, sessionId), "events");
    const files = await segmentFiles(this.rootDir, sessionId);
    let lastSeq = 0;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const filePath = path.join(eventsDir, files[fileIndex]!);
      for await (const record of legacyLines(filePath)) {
        const line = record.line;
        if (!line.trim()) continue;
        let event: LegacyAgentEventEnvelopeV2;
        try {
          event = decodeLegacyRecord(line.trim());
        } catch (error) {
          const tornFinalLine = fileIndex === files.length - 1 && !record.terminated;
          if (tornFinalLine) return;
          throw error;
        }
        if (event.sessionId !== sessionId) throw new Error(`V2 event session mismatch at seq ${event.seq}.`);
        if (event.seq !== lastSeq + 1) {
          throw new Error(`V2 event sequence discontinuity: expected ${lastSeq + 1}, actual ${event.seq}.`);
        }
        lastSeq = event.seq;
        if (event.seq > afterSeq) yield event;
      }
    }
  }

  async inspect(sessionId: string): Promise<LegacySessionInspectionV2> {
    const { meta, source } = await readLegacyMeta(this.rootDir, sessionId);
    const directory = legacySessionDirectoryV2(this.rootDir, sessionId);
    const names = await segmentFiles(this.rootDir, sessionId);
    const segments: LegacySegmentDigestV2[] = [];
    for (const name of names) {
      const { digest, bytes } = await digestFile(path.join(directory, "events", name));
      segments.push({ name, digest, bytes });
    }
    const scan = await scanLegacyEvents(this.rootDir, sessionId, 0);
    if (meta.lastSeq > scan.lastSeq) {
      throw new Error(`V2 metadata is ahead of durable events for '${sessionId}': ${meta.lastSeq} > ${scan.lastSeq}.`);
    }
    const metaDigest = sha256(source);
    const sourceDigest = sha256(JSON.stringify({ metaDigest, segments }));
    return {
      storeLayoutVersion: LEGACY_STORE_LAYOUT_VERSION_V2,
      eventSchemaVersion: LEGACY_EVENT_SCHEMA_VERSION_V2,
      sessionId,
      sourceDirectory: directory,
      sourceDigest,
      metaDigest,
      segments,
      eventCount: scan.eventCount,
      lastSeq: scan.lastSeq,
      metaLastSeq: meta.lastSeq,
      incompleteTail: scan.incompleteTail,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    };
  }

  async listSessions(): Promise<Array<{ sessionId: string; updatedAt: string; lastSeq: number }>> {
    const root = legacySessionsDirectoryV2(this.rootDir);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const { meta } = await readLegacyMeta(this.rootDir, entry.name);
        return { sessionId: meta.sessionId, updatedAt: meta.updatedAt, lastSeq: meta.lastSeq };
      } catch {
        return null;
      }
    }));
    return sessions.filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
