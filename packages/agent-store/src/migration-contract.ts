import type { AgentEventEnvelope, SnapshotEnvelope } from "agent-protocol";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION
} from "agent-protocol";
import type { AtomicReplace } from "./durable-file.js";
import type { LegacySessionInspectionV2 } from "./legacy-v2-store.js";
import type { MigrationSemanticProjection } from "./migration-semantics.js";

export type PromotionStatus = "dry_run" | "promoted" | "already_v3";
export type PromotionSnapshotStatus = "rebuilt" | "deferred";

export interface SnapshotRebuildInput {
  sessionId: string;
  lastSeq: number;
  events(): AsyncIterable<AgentEventEnvelope>;
}

export interface PromoteV2SessionOptions {
  rootDir: string;
  sessionId: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  segmentBytes?: number;
  segmentEvents?: number;
  replaceFile?: AtomicReplace;
  now?: () => string;
  rebuildSnapshot?: (input: SnapshotRebuildInput) => Promise<SnapshotEnvelope>;
  /** Deterministic fault/race injection after target publication and before
   * the mandatory source validation barrier. */
  afterPublish?: () => Promise<void>;
}

export interface SessionMigrationManifestV3 {
  schemaVersion: typeof STORE_LAYOUT_VERSION;
  migrationId: string;
  kind: "v2_to_v3_copy_on_write";
  sessionId: string;
  createdAt: string;
  source: {
    path: string;
    digest: string;
    lastSeq: number;
    eventCount: number;
    incompleteTail: boolean;
    semanticDigest: string;
    segments: LegacySessionInspectionV2["segments"];
  };
  target: {
    storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
    eventSchemaVersion: typeof EVENT_SCHEMA_VERSION;
    snapshotSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    path: string;
    digest: string;
    lastSeq: number;
    snapshot: PromotionSnapshotStatus;
    semanticDigest: string;
  };
}

export interface PromoteV2SessionResult {
  status: PromotionStatus;
  sessionId: string;
  sourcePath: string;
  targetPath: string;
  sourceDigest: string;
  targetDigest?: string;
  eventCount: number;
  lastSeq: number;
  incompleteTail: boolean;
  semanticDigest?: string;
  snapshot: PromotionSnapshotStatus;
  manifestPath?: string;
}

export type { MigrationSemanticProjection };
