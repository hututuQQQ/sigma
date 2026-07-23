import { createHash } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  LEGACY_EVENT_SCHEMA_VERSION_V5,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V6,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type SnapshotEnvelope
} from "agent-protocol";

export interface SessionMetaV5 {
  schemaVersion: typeof STORE_LAYOUT_VERSION;
  eventSchemaVersion: typeof LEGACY_EVENT_SCHEMA_VERSION_V5 | typeof EVENT_SCHEMA_VERSION;
  snapshotSchemaVersion: 5 | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V6 | typeof SNAPSHOT_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  segment: number;
  segmentEvents: number;
}

export interface LegacySnapshotEnvelopeV5 {
  schemaVersion: 5;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: unknown;
}

export interface LegacySnapshotEnvelopeV6 {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V6;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: unknown;
}

export interface StoredSnapshot {
  checksum: string;
  snapshot: SnapshotEnvelope | LegacySnapshotEnvelopeV5 | LegacySnapshotEnvelopeV6;
}

export function isSessionMetaV5(value: unknown, sessionId?: string): value is SessionMetaV5 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return [
    meta.schemaVersion === STORE_LAYOUT_VERSION,
    meta.eventSchemaVersion === LEGACY_EVENT_SCHEMA_VERSION_V5
      || meta.eventSchemaVersion === EVENT_SCHEMA_VERSION,
    meta.snapshotSchemaVersion === 5
      || meta.snapshotSchemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION_V6
      || meta.snapshotSchemaVersion === SNAPSHOT_SCHEMA_VERSION,
    typeof meta.sessionId === "string" && meta.sessionId.length > 0,
    sessionId === undefined || meta.sessionId === sessionId,
    typeof meta.createdAt === "string" && Number.isFinite(Date.parse(meta.createdAt)),
    typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt)),
    Number.isSafeInteger(meta.lastSeq) && Number(meta.lastSeq) >= 0,
    Number.isSafeInteger(meta.segment) && Number(meta.segment) >= 1,
    Number.isSafeInteger(meta.segmentEvents) && Number(meta.segmentEvents) >= 0
  ].every(Boolean);
}

export function snapshotChecksum(
  snapshot: SnapshotEnvelope | LegacySnapshotEnvelopeV5 | LegacySnapshotEnvelopeV6
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function isLegacySnapshotEnvelopeV6(value: unknown): value is LegacySnapshotEnvelopeV6 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION_V6
    && snapshot.storeLayoutVersion === STORE_LAYOUT_VERSION
    && typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0
    && typeof snapshot.createdAt === "string" && Number.isFinite(Date.parse(snapshot.createdAt))
    && snapshot.state !== undefined;
}

export function isLegacySnapshotEnvelopeV5(value: unknown): value is LegacySnapshotEnvelopeV5 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.schemaVersion === 5
    && snapshot.storeLayoutVersion === STORE_LAYOUT_VERSION
    && typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0
    && typeof snapshot.createdAt === "string" && Number.isFinite(Date.parse(snapshot.createdAt))
    && snapshot.state !== undefined;
}
