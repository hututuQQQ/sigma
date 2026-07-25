import { createHash } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  LEGACY_EVENT_SCHEMA_VERSION_V5,
  LEGACY_EVENT_SCHEMA_VERSION_V6,
  LEGACY_EVENT_SCHEMA_VERSION_V7,
  LEGACY_EVENT_SCHEMA_VERSION_V8,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V6,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V7,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V8,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V9,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type SnapshotEnvelope
} from "agent-protocol";

const SUPPORTED_EVENT_SCHEMA_VERSIONS: ReadonlySet<unknown> = new Set([
  LEGACY_EVENT_SCHEMA_VERSION_V5,
  LEGACY_EVENT_SCHEMA_VERSION_V6,
  LEGACY_EVENT_SCHEMA_VERSION_V7,
  LEGACY_EVENT_SCHEMA_VERSION_V8,
  EVENT_SCHEMA_VERSION
]);
const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS: ReadonlySet<unknown> = new Set([
  5,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V6,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V7,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V8,
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V9,
  SNAPSHOT_SCHEMA_VERSION
]);

export interface SessionMetaV5 {
  schemaVersion: typeof STORE_LAYOUT_VERSION;
  eventSchemaVersion: typeof LEGACY_EVENT_SCHEMA_VERSION_V5
    | typeof LEGACY_EVENT_SCHEMA_VERSION_V6
    | typeof LEGACY_EVENT_SCHEMA_VERSION_V7
    | typeof LEGACY_EVENT_SCHEMA_VERSION_V8
    | typeof EVENT_SCHEMA_VERSION;
  snapshotSchemaVersion: 5
    | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V6
    | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V7
    | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V8
    | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V9
    | typeof SNAPSHOT_SCHEMA_VERSION;
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

export interface LegacySnapshotEnvelopeV7 {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V7;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: unknown;
}

export interface LegacySnapshotEnvelopeV8 {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V8;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: unknown;
}

export interface LegacySnapshotEnvelopeV9 {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V9;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: unknown;
}

export interface StoredSnapshot {
  checksum: string;
  snapshot: SnapshotEnvelope | LegacySnapshotEnvelopeV5
    | LegacySnapshotEnvelopeV6 | LegacySnapshotEnvelopeV7 | LegacySnapshotEnvelopeV8
    | LegacySnapshotEnvelopeV9;
}

export function isSessionMetaV5(value: unknown, sessionId?: string): value is SessionMetaV5 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return [
    meta.schemaVersion === STORE_LAYOUT_VERSION,
    SUPPORTED_EVENT_SCHEMA_VERSIONS.has(meta.eventSchemaVersion),
    SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.has(meta.snapshotSchemaVersion),
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
  snapshot: SnapshotEnvelope | LegacySnapshotEnvelopeV5
    | LegacySnapshotEnvelopeV6 | LegacySnapshotEnvelopeV7 | LegacySnapshotEnvelopeV8
    | LegacySnapshotEnvelopeV9
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function isLegacySnapshotEnvelopeV9(value: unknown): value is LegacySnapshotEnvelopeV9 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION_V9
    && snapshot.storeLayoutVersion === STORE_LAYOUT_VERSION
    && typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0
    && typeof snapshot.createdAt === "string" && Number.isFinite(Date.parse(snapshot.createdAt))
    && snapshot.state !== undefined;
}

export function isLegacySnapshotEnvelopeV8(value: unknown): value is LegacySnapshotEnvelopeV8 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION_V8
    && snapshot.storeLayoutVersion === STORE_LAYOUT_VERSION
    && typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0
    && typeof snapshot.createdAt === "string" && Number.isFinite(Date.parse(snapshot.createdAt))
    && snapshot.state !== undefined;
}

export function isLegacySnapshotEnvelopeV7(value: unknown): value is LegacySnapshotEnvelopeV7 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION_V7
    && snapshot.storeLayoutVersion === STORE_LAYOUT_VERSION
    && typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0
    && typeof snapshot.createdAt === "string" && Number.isFinite(Date.parse(snapshot.createdAt))
    && snapshot.state !== undefined;
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
