import { createHash } from "node:crypto";
import {
  STORE_LAYOUT_VERSION,
  type SnapshotEnvelope
} from "agent-protocol";

export interface SessionMeta {
  schemaVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  segment: number;
  segmentEvents: number;
}

export interface StoredSnapshot {
  checksum: string;
  snapshot: SnapshotEnvelope;
}

export function isSessionMeta(value: unknown, sessionId?: string): value is SessionMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  const keys = [
    "createdAt", "lastSeq", "schemaVersion", "segment",
    "segmentEvents", "sessionId", "updatedAt"
  ];
  return [
    JSON.stringify(Object.keys(meta).sort()) === JSON.stringify(keys),
    meta.schemaVersion === STORE_LAYOUT_VERSION,
    typeof meta.sessionId === "string" && meta.sessionId.length > 0,
    sessionId === undefined || meta.sessionId === sessionId,
    typeof meta.createdAt === "string" && Number.isFinite(Date.parse(meta.createdAt)),
    typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)),
    Number.isSafeInteger(meta.lastSeq) && Number(meta.lastSeq) >= 0,
    Number.isSafeInteger(meta.segment) && Number(meta.segment) >= 1,
    Number.isSafeInteger(meta.segmentEvents) && Number(meta.segmentEvents) >= 0
  ].every(Boolean);
}

export function snapshotChecksum(snapshot: SnapshotEnvelope): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
