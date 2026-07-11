import type { AnyTypedAgentEvent, ExternalEvaluationReport } from "./events.js";
import { isJsonValue, type JsonValue } from "./json.js";
import {
  LEGACY_SNAPSHOT_SCHEMA_VERSION_V2,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION
} from "./versions.js";

export interface SnapshotEnvelope<TState extends JsonValue = JsonValue> {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: TState;
}

export interface LegacySnapshotEnvelopeV2<TState extends JsonValue = JsonValue> {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION_V2;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: TState;
}

export interface StoreAppendResult {
  rotated: boolean;
}

export interface RunStore {
  append(event: AnyTypedAgentEvent, expectedSeq: number): Promise<StoreAppendResult>;
  events(sessionId: string, afterSeq?: number): AsyncIterable<AnyTypedAgentEvent>;
  writeSnapshot(snapshot: SnapshotEnvelope): Promise<void>;
  latestSnapshot(sessionId: string): Promise<SnapshotEnvelope | null>;
  listSessions(): Promise<Array<{ sessionId: string; updatedAt: string; lastSeq: number }>>;
}

export interface EvaluationSink {
  append(report: ExternalEvaluationReport): Promise<void>;
}

function snapshotRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validSnapshotMetadata(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string" && value.sessionId.length > 0
    && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && isJsonValue(value.state);
}

export function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  const snapshot = snapshotRecord(value);
  return Boolean(snapshot && snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION
    && snapshot.storeLayoutVersion === STORE_LAYOUT_VERSION && validSnapshotMetadata(snapshot));
}

export function assertSnapshotEnvelope(value: unknown): asserts value is SnapshotEnvelope {
  if (!isSnapshotEnvelope(value)) throw new Error("Invalid SnapshotEnvelope V3.");
}

export function isLegacySnapshotEnvelopeV2(value: unknown): value is LegacySnapshotEnvelopeV2 {
  const snapshot = snapshotRecord(value);
  return Boolean(snapshot && snapshot.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION_V2
    && validSnapshotMetadata(snapshot));
}

export function assertLegacySnapshotEnvelopeV2(value: unknown): asserts value is LegacySnapshotEnvelopeV2 {
  if (!isLegacySnapshotEnvelopeV2(value)) throw new Error("Invalid SnapshotEnvelope V2.");
}
