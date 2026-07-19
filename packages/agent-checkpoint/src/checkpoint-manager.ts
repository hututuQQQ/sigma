import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { workspaceTransactionRoot } from "agent-platform";
import type {
  CheckpointManagerOptions,
  CheckpointOpaqueArtifact,
  CheckpointManifest,
  CheckpointRecord,
  CheckpointReviewMaterial,
  CreateCheckpointInput,
  OpenCheckpointInspection,
  SealedCheckpointInspection
} from "./types.js";
import { CheckpointConflictError } from "./types.js";
import { normalizeCheckpointScopes, safeCheckpointId as safeId } from "./path-safety.js";
import { restoreCheckpointTransaction } from "./restore-transaction.js";
import { recoverCheckpointTransactions } from "./restore-recovery.js";
import { captureCheckpointManifest } from "./safe-capture.js";
import { CheckpointStateStore } from "./checkpoint-state-store.js";
import { selectReproducibleRoots } from "./reproducible-roots.js";
import { buildCheckpointReviewMaterial } from "./checkpoint-review.js";
import { checkpointOpaqueArtifacts } from "./opaque-artifacts.js";
import type { CheckpointRestoreFaultInjector } from "./fault-injection.js";

export { checkpointDelta } from "./manifest.js";
export class CheckpointManager {
  private readonly rootDir: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly excludedNames: ReadonlySet<string>;
  private readonly restoreFaultInjector: CheckpointRestoreFaultInjector | undefined;
  private readonly store: CheckpointStateStore;
  constructor(options: CheckpointManagerOptions, restoreFaultInjector?: CheckpointRestoreFaultInjector) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxFiles = options.maxFiles ?? 250_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.excludedNames = new Set(options.excludedNames ?? [".git", ".agent"]);
    this.restoreFaultInjector = restoreFaultInjector;
    this.store = new CheckpointStateStore(this.rootDir);
  }
  async create(input: CreateCheckpointInput): Promise<CheckpointRecord> {
    const { workspacePath, scopePaths } = await normalizeCheckpointScopes(input.workspacePath, input.scopePaths);
    await this.recover(workspacePath);
    const open = (await this.list(input.sessionId)).find((item) => item.status === "open");
    if (open) {
      throw new CheckpointConflictError(
        `Checkpoint ${open.checkpointId} is still open; resolve it before creating another checkpoint.`
      );
    }
    const reproducibleRootPaths = await selectReproducibleRoots({
      workspacePath,
      scopePaths,
      requestedPaths: input.reproducibleRootPaths ?? [],
      explicitDeliverablePaths: input.explicitDeliverablePaths ?? [],
      excludedNames: this.excludedNames
    });
    const preManifestDigest = await this.captureDigest(workspacePath, scopePaths, reproducibleRootPaths);
    const record: CheckpointRecord = {
      schemaVersion: 1,
      checkpointId: `${Date.now().toString(36)}-${randomUUID()}`,
      sessionId: safeId(input.sessionId, "session identifier"),
      runId: safeId(input.runId, "run identifier"),
      status: "open",
      workspacePath,
      scopePaths,
      baseSeq: input.baseSeq,
      createdAt: new Date().toISOString(),
      preManifestDigest,
      ...(reproducibleRootPaths.length > 0 ? { reproducibleRootPaths } : {})
    };
    await this.store.writeRecord(record);
    return record;
  }
  async seal(
    sessionId: string,
    checkpointId: string,
    expectedCurrentManifestDigest?: string
  ): Promise<CheckpointRecord> {
    let record = await this.store.readRecord(sessionId, checkpointId);
    await this.recover(record.workspacePath);
    record = await this.store.readRecord(sessionId, checkpointId);
    if (record.status !== "open") throw new Error(`Checkpoint ${checkpointId} is not open.`);
    await this.assertLatestUnresolved(sessionId, checkpointId, "open");
    const postManifestDigest = await this.captureDigest(
      record.workspacePath,
      record.scopePaths,
      record.reproducibleRootPaths ?? []
    );
    if (expectedCurrentManifestDigest !== undefined && postManifestDigest !== expectedCurrentManifestDigest) {
      throw new CheckpointConflictError(
        `Workspace changed after checkpoint ${checkpointId} recovery was offered; keep was not started.`
      );
    }
    const delta = await this.store.deltaBetween(record.preManifestDigest, postManifestDigest);
    const sealed: CheckpointRecord = {
      ...record,
      status: "sealed",
      sealedAt: new Date().toISOString(),
      postManifestDigest,
      deltaDigest: await this.store.putDelta(delta),
      delta
    };
    await this.store.writeRecord(sealed);
    return sealed;
  }
  async list(sessionId: string): Promise<CheckpointRecord[]> {
    const directory = this.store.sessionDirectory(sessionId);
    const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    const records = await Promise.all(names.map(async (name) =>
      await this.store.readRecord(sessionId, name.slice(0, -5))));
    return records.sort((left, right) => left.baseSeq - right.baseSeq
      || left.createdAt.localeCompare(right.createdAt)
      || left.checkpointId.localeCompare(right.checkpointId));
  }
  async inspectOpen(sessionId: string, checkpointId: string): Promise<OpenCheckpointInspection> {
    let checkpoint = await this.store.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.store.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "open") throw new Error(`Checkpoint ${checkpointId} is not open.`);
    const currentManifestDigest = await this.captureDigest(
      checkpoint.workspacePath,
      checkpoint.scopePaths,
      checkpoint.reproducibleRootPaths ?? []
    );
    return {
      checkpoint,
      currentManifestDigest,
      changed: currentManifestDigest !== checkpoint.preManifestDigest,
      delta: await this.store.deltaBetween(checkpoint.preManifestDigest, currentManifestDigest)
    };
  }
  async inspectSealed(sessionId: string, checkpointId: string): Promise<SealedCheckpointInspection> {
    let checkpoint = await this.store.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.store.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "sealed" || !checkpoint.postManifestDigest) {
      throw new Error(`Checkpoint ${checkpointId} is not sealed.`);
    }
    const currentManifestDigest = await this.captureDigest(
      checkpoint.workspacePath,
      checkpoint.scopePaths,
      checkpoint.reproducibleRootPaths ?? []
    );
    return {
      checkpoint,
      currentManifestDigest,
      changed: currentManifestDigest !== checkpoint.postManifestDigest
    };
  }
  async reviewDiff(sessionId: string, checkpointId: string, maxBytes = 256 * 1024): Promise<string> {
    return (await this.reviewMaterial(sessionId, checkpointId, maxBytes)).reviewDiff;
  }

  async reviewMaterial(
    sessionId: string,
    checkpointId: string,
    maxBytes = 256 * 1024
  ): Promise<CheckpointReviewMaterial> {
    const { checkpoint, before, after } = await this.sealedReviewState(sessionId, checkpointId);
    const opaqueArtifacts = await checkpointOpaqueArtifacts(checkpoint, before, after, this.store.cas);
    return await buildCheckpointReviewMaterial(
      checkpoint,
      before,
      after,
      this.store.cas,
      maxBytes,
      opaqueArtifacts
    );
  }

  /** Returns content-addressed identities for changed files whose bytes are
   * not safe to represent as text. This is independent of the bounded review
   * preview, so a truncated preview cannot invalidate binary evidence. */
  async opaqueArtifacts(sessionId: string, checkpointId: string): Promise<CheckpointOpaqueArtifact[]> {
    const { checkpoint, before, after } = await this.sealedReviewState(sessionId, checkpointId);
    return await checkpointOpaqueArtifacts(checkpoint, before, after, this.store.cas);
  }

  async undoLatest(sessionId: string): Promise<CheckpointRecord> {
    let records = await this.list(sessionId);
    let latest = [...records].reverse().find((item) => item.status !== "restored");
    if (latest) {
      await this.recover(latest.workspacePath);
      records = await this.list(sessionId);
      latest = [...records].reverse().find((item) => item.status !== "restored");
    }
    if (latest?.status === "open") {
      throw new CheckpointConflictError(
        `Checkpoint ${latest.checkpointId} is still open; resolve it before undoing an older checkpoint.`
      );
    }
    if (!latest?.postManifestDigest) throw new Error(`Session ${sessionId} has no sealed checkpoint to undo.`);
    const currentDigest = await this.captureDigest(
      latest.workspacePath,
      latest.scopePaths,
      latest.reproducibleRootPaths ?? []
    );
    if (currentDigest !== latest.postManifestDigest) {
      throw new CheckpointConflictError(
        `Workspace no longer matches checkpoint ${latest.checkpointId} postimage; undo was not started.`
      );
    }
    const before = await this.store.getManifest(latest.preManifestDigest);
    const after = await this.store.getManifest(latest.postManifestDigest);
    const restored: CheckpointRecord = {
      ...latest,
      status: "restored",
      restoredAt: new Date().toISOString()
    };
    await this.restore(
      latest.workspacePath,
      latest.scopePaths,
      before,
      after,
      restored
    );
    return restored;
  }

  async restoreOpen(
    sessionId: string,
    checkpointId: string,
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRecord> {
    let checkpoint = await this.store.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.store.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "open") throw new Error(`Checkpoint ${checkpointId} is not open.`);
    await this.assertLatestUnresolved(sessionId, checkpointId, "open");
    const currentManifestDigest = await this.captureDigest(
      checkpoint.workspacePath,
      checkpoint.scopePaths,
      checkpoint.reproducibleRootPaths ?? []
    );
    if (currentManifestDigest !== expectedCurrentManifestDigest) {
      throw new CheckpointConflictError(
        `Workspace changed after checkpoint ${checkpointId} recovery was offered; restore was not started.`
      );
    }
    const delta = await this.store.deltaBetween(checkpoint.preManifestDigest, currentManifestDigest);
    const before = await this.store.getManifest(checkpoint.preManifestDigest);
    const current = await this.store.getManifest(currentManifestDigest);
    const restored: CheckpointRecord = {
      ...checkpoint,
      status: "restored",
      restoredAt: new Date().toISOString(),
      postManifestDigest: currentManifestDigest,
      deltaDigest: await this.store.putDelta(delta),
      delta
    };
    await this.restore(
      checkpoint.workspacePath,
      checkpoint.scopePaths,
      before,
      current,
      restored
    );
    return restored;
  }

  private async assertLatestUnresolved(
    sessionId: string,
    checkpointId: string,
    status: CheckpointRecord["status"]
  ): Promise<void> {
    const latest = [...await this.list(sessionId)].reverse().find((item) => item.status !== "restored");
    if (!latest || latest.checkpointId !== checkpointId || latest.status !== status) {
      throw new CheckpointConflictError(
        `Checkpoint ${checkpointId} is not the latest unresolved ${status} checkpoint.`
      );
    }
  }

  private async capture(
    workspacePath: string,
    scopePaths: readonly string[],
    reproducibleRootPaths: readonly string[] = [],
    ignoredRootName?: string
  ): Promise<CheckpointManifest> {
    return await captureCheckpointManifest({
      workspacePath,
      scopePaths,
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      excludedNames: this.excludedNames,
      ...(reproducibleRootPaths.length > 0
        ? { reproducibleRootPaths: new Set(reproducibleRootPaths) }
        : {}),
      ...(ignoredRootName ? { ignoredRootName } : {}),
      putCas: async (content) => await this.store.cas.putStream(content)
    });
  }

  private async captureDigest(
    workspacePath: string,
    scopePaths: readonly string[],
    reproducibleRootPaths: readonly string[] = [],
    ignoredRootName?: string
  ): Promise<string> {
    return await this.store.captureManifest({
      workspacePath,
      scopePaths,
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      excludedNames: this.excludedNames,
      ...(reproducibleRootPaths.length > 0
        ? { reproducibleRootPaths: new Set(reproducibleRootPaths) }
        : {}),
      ...(ignoredRootName ? { ignoredRootName } : {})
    });
  }

  private async sealedReviewState(
    sessionId: string,
    checkpointId: string
  ): Promise<{ checkpoint: CheckpointRecord; before: CheckpointManifest; after: CheckpointManifest }> {
    let checkpoint = await this.store.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.store.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "sealed" || !checkpoint.postManifestDigest || !checkpoint.delta) {
      throw new Error(`Checkpoint ${checkpointId} is not sealed for review.`);
    }
    return {
      checkpoint,
      before: await this.store.getManifest(checkpoint.preManifestDigest),
      after: await this.store.getManifest(checkpoint.postManifestDigest)
    };
  }

  private async restore(
    workspacePath: string,
    scopePaths: readonly string[],
    desired: CheckpointManifest,
    current: CheckpointManifest,
    restored: CheckpointRecord
  ): Promise<void> {
    await restoreCheckpointTransaction({
      workspacePath,
      transactionRootDir: await this.transactionRoot(workspacePath),
      desired,
      current,
      readCas: (digest) => this.store.cas.stream(digest),
      capture: async (ignoredRootName) => await this.capture(
        workspacePath,
        scopePaths,
        restored.reproducibleRootPaths ?? [],
        ignoredRootName
      ),
      finalization: {
        record: this.store.persistedRecord(restored),
        desiredManifestDigest: restored.preManifestDigest
      },
      finalize: async () => await this.store.writeRecord(restored),
      ...(this.restoreFaultInjector ? { faultInjector: this.restoreFaultInjector } : {})
    });
  }

  private async recover(workspacePath: string): Promise<void> {
    const canonical = path.resolve(workspacePath);
    await recoverCheckpointTransactions({
      workspacePath: canonical,
      transactionRootDir: await this.transactionRoot(canonical),
      finalize: async ({ record, desiredManifestDigest }) => {
        if (record.schemaVersion !== 1 || record.status !== "restored"
          || path.resolve(record.workspacePath) !== canonical
          || record.preManifestDigest !== desiredManifestDigest) {
          throw new CheckpointConflictError("Checkpoint recovery finalization identity is invalid.");
        }
        // Recompute the target through validated identifiers; never trust a path from the workspace journal.
        this.store.recordPath(record.sessionId, record.checkpointId);
        const currentDigest = await this.captureDigest(
          canonical,
          record.scopePaths,
          record.reproducibleRootPaths ?? []
        );
        if (currentDigest !== desiredManifestDigest) {
          throw new CheckpointConflictError("Verified checkpoint recovery no longer matches its desired manifest.");
        }
        await this.store.writeRecord(record);
      }
    });
  }

  private async transactionRoot(workspacePath: string): Promise<string> {
    return await workspaceTransactionRoot({
      workspacePath,
      stateRootDir: this.rootDir,
      namespace: "checkpoint-restore"
    });
  }
}
