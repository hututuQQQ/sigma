import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireProcessOwnerLease } from "agent-platform";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  assertSnapshotEnvelope
} from "agent-protocol";
import { atomicJson } from "./durable-file.js";
import { V2ReadOnlySessionStore, type LegacySessionInspectionV2 } from "./legacy-v2-store.js";
import {
  assertMigrationReplaySnapshot,
  assertMigrationSemanticEquivalence,
  projectMigrationSemantics,
  type MigrationSemanticProjection
} from "./migration-semantics.js";
import type {
  PromoteV2SessionOptions,
  PromoteV2SessionResult,
  PromotionSnapshotStatus,
  SessionMigrationManifestV3
} from "./migration-contract.js";
import { copyLegacyEvents, rebuildTargetSnapshot, targetStoreOptions } from "./migration-staging.js";
import { assertLegacySourceQuiescent, targetFingerprint } from "./migration-barrier.js";
import { safeId, sessionDirectory, sessionsDirectory, storeVersionDirectory } from "./paths.js";
import { isSessionMetaV3, SegmentedJsonlStore } from "./segmented-jsonl-store.js";

export type {
  PromoteV2SessionOptions,
  PromoteV2SessionResult,
  PromotionSnapshotStatus,
  PromotionStatus,
  SessionMigrationManifestV3,
  SnapshotRebuildInput
} from "./migration-contract.js";

export { assertPromotedV2SourceUnchanged } from "./migration-barrier.js";

async function exists(filePath: string): Promise<boolean> {
  return await access(filePath).then(() => true, (error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  });
}

async function validExistingTarget(targetPath: string, sessionId: string): Promise<boolean> {
  try {
    const meta = JSON.parse(await readFile(path.join(targetPath, "meta.json"), "utf8")) as unknown;
    return isSessionMetaV3(meta, sessionId);
  } catch {
    return false;
  }
}

function alreadyV3(
  source: LegacySessionInspectionV2,
  targetPath: string,
  targetDigest: string,
  semanticDigest: string
): PromoteV2SessionResult {
  return {
    status: "already_v3",
    sessionId: source.sessionId,
    sourcePath: source.sourceDirectory,
    targetPath,
    sourceDigest: source.sourceDigest,
    targetDigest,
    eventCount: source.eventCount,
    lastSeq: source.lastSeq,
    incompleteTail: source.incompleteTail,
    semanticDigest,
    snapshot: "deferred"
  };
}

interface PromotionContext {
  rootDir: string;
  sessionId: string;
  sourcePath: string;
  targetPath: string;
  legacy: V2ReadOnlySessionStore;
}

interface StagedTarget {
  temporaryRoot: string;
  temporarySessionPath: string;
  targetDigest: string;
  snapshot: PromotionSnapshotStatus;
  semantics: MigrationSemanticProjection;
}

function sameSource(
  expected: LegacySessionInspectionV2,
  actual: LegacySessionInspectionV2
): boolean {
  return actual.sourceDigest === expected.sourceDigest
    && actual.metaDigest === expected.metaDigest
    && actual.eventCount === expected.eventCount
    && actual.lastSeq === expected.lastSeq
    && actual.incompleteTail === expected.incompleteTail;
}

async function assertSourceUnchanged(
  context: PromotionContext,
  expected: LegacySessionInspectionV2
): Promise<void> {
  const actual = await context.legacy.inspect(context.sessionId);
  if (!sameSource(expected, actual)) {
    throw new Error(`V2 source changed while promoting '${context.sessionId}'; promotion was aborted.`);
  }
}

function dryRunResult(
  source: LegacySessionInspectionV2,
  targetPath: string,
  rebuildSnapshot: boolean
): PromoteV2SessionResult {
  return {
    status: "dry_run",
    sessionId: source.sessionId,
    sourcePath: source.sourceDirectory,
    targetPath,
    sourceDigest: source.sourceDigest,
    eventCount: source.eventCount,
    lastSeq: source.lastSeq,
    incompleteTail: source.incompleteTail,
    snapshot: rebuildSnapshot ? "rebuilt" : "deferred"
  };
}

function migrationManifest(
  source: LegacySessionInspectionV2,
  targetPath: string,
  targetDigest: string,
  semanticDigest: string,
  snapshot: PromotionSnapshotStatus,
  createdAt: string
): SessionMigrationManifestV3 {
  return {
    schemaVersion: STORE_LAYOUT_VERSION,
    migrationId: randomUUID(),
    kind: "v2_to_v3_copy_on_write",
    sessionId: source.sessionId,
    createdAt,
    source: {
      path: source.sourceDirectory,
      digest: source.sourceDigest,
      lastSeq: source.lastSeq,
      eventCount: source.eventCount,
      incompleteTail: source.incompleteTail,
      semanticDigest,
      segments: source.segments
    },
    target: {
      storeLayoutVersion: STORE_LAYOUT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      path: targetPath,
      digest: targetDigest,
      lastSeq: source.lastSeq,
      snapshot,
      semanticDigest
    }
  };
}

async function sourceSemantics(
  context: PromotionContext,
  source: LegacySessionInspectionV2
): Promise<MigrationSemanticProjection> {
  const projected = await projectMigrationSemantics(source.sessionId, context.legacy.events(source.sessionId));
  if (projected.eventCount !== source.eventCount || projected.lastSeq !== source.lastSeq) {
    throw new Error(`V2 semantic replay does not match inspected source '${source.sessionId}'.`);
  }
  return projected;
}

async function verifyTargetSemantics(
  source: MigrationSemanticProjection,
  targetStore: SegmentedJsonlStore
): Promise<MigrationSemanticProjection> {
  const projected = await projectMigrationSemantics(source.sessionId, targetStore.events(source.sessionId));
  assertMigrationSemanticEquivalence(source, projected);
  return projected;
}

async function verifyExistingReplay(
  options: PromoteV2SessionOptions,
  source: MigrationSemanticProjection,
  targetStore: SegmentedJsonlStore
): Promise<void> {
  if (!options.rebuildSnapshot) return;
  const replayed = await options.rebuildSnapshot({
    sessionId: source.sessionId,
    lastSeq: source.lastSeq,
    events: () => targetStore.events(source.sessionId)
  });
  assertSnapshotEnvelope(replayed);
  if (replayed.sessionId !== source.sessionId || replayed.seq !== source.lastSeq) {
    throw new Error(`Replayed V3 target does not match existing session '${source.sessionId}' at seq ${source.lastSeq}.`);
  }
  assertMigrationReplaySnapshot(source, replayed);
}

async function buildStagedTarget(
  options: PromoteV2SessionOptions,
  context: PromotionContext,
  source: LegacySessionInspectionV2
): Promise<StagedTarget> {
  const temporaryRoot = path.join(
    context.rootDir, "stores", `v${STORE_LAYOUT_VERSION}`, `.promotion-${context.sessionId}-${randomUUID()}`
  );
  try {
    await copyLegacyEvents(options, context, source, temporaryRoot, options.signal);
    const targetStore = new SegmentedJsonlStore(targetStoreOptions(options, temporaryRoot));
    const rebuilt = await rebuildTargetSnapshot(options, source, targetStore);
    const temporarySessionPath = sessionDirectory(temporaryRoot, context.sessionId);
    await assertSourceUnchanged(context, source);
    const sourceProjection = await sourceSemantics(context, source);
    // The semantic replay is another complete source read. Re-validate after it
    // so a concurrent legacy writer cannot publish a mixed source image.
    await assertSourceUnchanged(context, source);
    const semantics = await verifyTargetSemantics(sourceProjection, targetStore);
    assertMigrationReplaySnapshot(sourceProjection, rebuilt.snapshot);
    const targetDigest = await targetFingerprint(temporarySessionPath);
    const createdAt = options.now?.() ?? new Date().toISOString();
    await atomicJson(
      path.join(temporarySessionPath, "migration.json"),
      migrationManifest(source, context.targetPath, targetDigest, semantics.semanticDigest, rebuilt.status, createdAt),
      options.replaceFile
    );
    return { temporaryRoot, temporarySessionPath, targetDigest, snapshot: rebuilt.status, semantics };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupStalePromotions(rootDir: string, sessionId: string): Promise<void> {
  const v3Root = path.dirname(sessionsDirectory(rootDir));
  const prefix = `.promotion-${sessionId}-`;
  const entries = await readdir(v3Root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      await rm(path.join(v3Root, entry.name), { recursive: true, force: true });
    }
  }
}

function promotedResult(
  source: LegacySessionInspectionV2,
  targetPath: string,
  staged: StagedTarget
): PromoteV2SessionResult {
  return {
    status: "promoted",
    sessionId: source.sessionId,
    sourcePath: source.sourceDirectory,
    targetPath,
    sourceDigest: source.sourceDigest,
    targetDigest: staged.targetDigest,
    eventCount: source.eventCount,
    lastSeq: source.lastSeq,
    incompleteTail: source.incompleteTail,
    semanticDigest: staged.semantics.semanticDigest,
    snapshot: staged.snapshot,
    manifestPath: path.join(targetPath, "migration.json")
  };
}

async function publishStagedTarget(
  context: PromotionContext,
  source: LegacySessionInspectionV2,
  staged: StagedTarget
): Promise<PromoteV2SessionResult> {
  await mkdir(sessionsDirectory(context.rootDir), { recursive: true });
  try {
    await rename(staged.temporarySessionPath, context.targetPath);
    return promotedResult(source, context.targetPath, staged);
  } catch (error) {
    const collision = ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String((error as { code?: unknown }).code));
    if (!collision || !await validExistingTarget(context.targetPath, context.sessionId)) throw error;
    const target = new SegmentedJsonlStore({ rootDir: context.rootDir });
    const semantics = await verifyTargetSemantics(staged.semantics, target);
    return alreadyV3(source, context.targetPath, await targetFingerprint(context.targetPath), semantics.semanticDigest);
  }
}

async function promoteWhileLocked(
  options: PromoteV2SessionOptions,
  context: PromotionContext
): Promise<PromoteV2SessionResult> {
  options.signal?.throwIfAborted();
  await cleanupStalePromotions(context.rootDir, context.sessionId);
  await assertLegacySourceQuiescent(context.sourcePath);
  const source = await context.legacy.inspect(context.sessionId);
  if (source.eventCount === 0) throw new Error(`Cannot promote empty V2 session '${context.sessionId}'.`);
  if (await exists(context.targetPath)) {
    if (!await validExistingTarget(context.targetPath, context.sessionId)) {
      throw new Error(`V3 target already exists but is invalid for session '${context.sessionId}'.`);
    }
    const sourceProjection = await sourceSemantics(context, source);
    const target = new SegmentedJsonlStore({ rootDir: context.rootDir });
    const semantics = await verifyTargetSemantics(sourceProjection, target);
    await verifyExistingReplay(options, sourceProjection, target);
    return alreadyV3(source, context.targetPath, await targetFingerprint(context.targetPath), semantics.semanticDigest);
  }
  if (options.dryRun) return dryRunResult(source, context.targetPath, Boolean(options.rebuildSnapshot));
  const staged = await buildStagedTarget(options, context, source);
  try {
    // Keep the V2 tree strictly read-only. The promotion lease lives in V3,
    // while repeated source digests detect legacy writes before publication.
    await assertLegacySourceQuiescent(context.sourcePath);
    await assertSourceUnchanged(context, source);
    const published = await publishStagedTarget(context, source, staged);
    try {
      await options.afterPublish?.();
      await assertLegacySourceQuiescent(context.sourcePath);
      await assertSourceUnchanged(context, source);
      return published;
    } catch (error) {
      if (published.status === "promoted") {
        await rm(context.targetPath, { recursive: true, force: true });
      }
      throw error;
    }
  } finally {
    await rm(staged.temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Promote one immutable V2 session into the V3 tree. The V2 directory is never
 * written, including for locking. The target is constructed completely off to
 * the side, the source is re-verified after every complete read, and the target
 * is then published with a single directory rename.
 */
export async function promoteV2Session(options: PromoteV2SessionOptions): Promise<PromoteV2SessionResult> {
  const rootDir = path.resolve(options.rootDir);
  const sessionId = safeId(options.sessionId);
  const sourcePath = path.join(rootDir, "sessions", sessionId);
  const targetPath = sessionDirectory(rootDir, sessionId);
  if (!await exists(path.join(sourcePath, "meta.json"))) throw new Error(`V2 session '${sessionId}' does not exist.`);
  const lockDirectory = path.join(storeVersionDirectory(rootDir), "migration-locks");
  await mkdir(lockDirectory, { recursive: true });
  const owner = await acquireProcessOwnerLease(path.join(lockDirectory, `${sessionId}.lock`), {
    pid: process.pid,
    instanceId: randomUUID(),
    startedAt: new Date().toISOString()
  }, {
    label: "V2 session promotion",
    activeOwner: "reject",
    timeoutMs: 10_000,
    malformedStaleMs: 5_000,
    signal: options.signal
  });
  try {
    return await promoteWhileLocked(options, {
      rootDir,
      sessionId,
      sourcePath,
      targetPath,
      legacy: new V2ReadOnlySessionStore(rootDir)
    });
  } finally {
    await owner.release();
  }
}
