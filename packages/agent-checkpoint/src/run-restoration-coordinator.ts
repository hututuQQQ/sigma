import type {
  CheckpointManifest,
  CheckpointRecord,
  RunRestorationInspection
} from "./types.js";
import { CheckpointConflictError } from "./types.js";
import type { CheckpointRestoreFaultInjector } from "./fault-injection.js";
import {
  reconstructRunBaseline,
  runScopePaths,
  semanticManifestDigest,
  type RunCheckpointImage
} from "./run-restoration.js";
import { manifestEqual } from "./restore-manifest-validation.js";
import { restoreCheckpointTransaction } from "./restore-transaction.js";
import type { RestoreCasReader } from "./restore-cas.js";

export interface RunRestorationDependencies {
  list(sessionId: string): Promise<CheckpointRecord[]>;
  recover(workspacePath: string): Promise<void>;
  capture(workspacePath: string, scopePaths: readonly string[], ignoredRootName?: string): Promise<CheckpointManifest>;
  getManifest(digest: string): Promise<CheckpointManifest>;
  putManifest(manifest: CheckpointManifest): Promise<string>;
  transactionRoot(workspacePath: string): Promise<string>;
  writeRecords(records: readonly CheckpointRecord[]): Promise<void>;
  readCas: RestoreCasReader;
  restoreFaultInjector?: CheckpointRestoreFaultInjector;
}

/** Coordinates whole-run restoration while CheckpointManager remains the
 * authority for storage, capture, recovery, and transaction paths. */
export class RunRestorationCoordinator {
  constructor(private readonly dependencies: RunRestorationDependencies) {}

  async inspect(sessionId: string, runId: string): Promise<RunRestorationInspection> {
    const records = (await this.dependencies.list(sessionId)).filter((item) => item.runId === runId);
    if (records.length === 0) {
      throw new CheckpointConflictError(`Run ${runId} has no checkpoint history to confirm.`);
    }
    const workspacePath = records[0]!.workspacePath;
    await this.dependencies.recover(workspacePath);
    const currentRecords = (await this.dependencies.list(sessionId)).filter((item) => item.runId === runId);
    const images = await this.runImages(currentRecords);
    const scopes = runScopePaths(currentRecords);
    const current = await this.dependencies.capture(workspacePath, scopes);
    const desired = reconstructRunBaseline(current, images).desired;
    return {
      checkpoints: currentRecords,
      baselineManifestDigest: semanticManifestDigest(desired),
      currentManifestDigest: semanticManifestDigest(current),
      restored: manifestEqual(current, desired)
    };
  }

  async restore(sessionId: string, runId: string): Promise<RunRestorationInspection> {
    const all = await this.dependencies.list(sessionId);
    const unresolved = all.filter((item) => item.status !== "restored");
    if (unresolved.some((item) => item.status === "open")) {
      throw new CheckpointConflictError("Resolve the open checkpoint before restoring run changes.");
    }
    const first = unresolved.findIndex((item) => item.runId === runId);
    if (first < 0 || unresolved.slice(first).some((item) => item.runId !== runId)) {
      throw new CheckpointConflictError(`Run ${runId} is not the latest restorable checkpoint group.`);
    }
    const records = unresolved.slice(first);
    const workspacePath = records[0]!.workspacePath;
    if (records.some((item) => item.workspacePath !== workspacePath || !item.postManifestDigest)) {
      throw new CheckpointConflictError("Run checkpoint history is incomplete or crosses workspace roots.");
    }
    await this.dependencies.recover(workspacePath);
    const scopes = runScopePaths(records);
    const current = await this.dependencies.capture(workspacePath, scopes);
    const reconstructed = reconstructRunBaseline(current, await this.runImages(records));
    if (!reconstructed.chainMatches) {
      throw new CheckpointConflictError("Workspace no longer matches the recorded run checkpoint chain.");
    }
    const desiredManifestDigest = await this.dependencies.putManifest(reconstructed.desired);
    const restoredAt = new Date().toISOString();
    const restored = records.map((record): CheckpointRecord => ({ ...record, status: "restored", restoredAt }));
    await restoreCheckpointTransaction({
      workspacePath,
      transactionRootDir: await this.dependencies.transactionRoot(workspacePath),
      desired: reconstructed.desired,
      current,
      readCas: (digest) => this.dependencies.readCas(digest),
      capture: async (ignoredRootName) => await this.dependencies.capture(workspacePath, scopes, ignoredRootName),
      finalization: { kind: "run", records: restored, desiredManifestDigest },
      finalize: async () => await this.dependencies.writeRecords(restored),
      ...(this.dependencies.restoreFaultInjector
        ? { faultInjector: this.dependencies.restoreFaultInjector }
        : {})
    });
    const manifestDigest = semanticManifestDigest(reconstructed.desired);
    return {
      checkpoints: restored,
      baselineManifestDigest: manifestDigest,
      currentManifestDigest: manifestDigest,
      restored: true
    };
  }

  private async runImages(records: readonly CheckpointRecord[]): Promise<RunCheckpointImage[]> {
    return await Promise.all(records.map(async (record) => {
      if (!record.postManifestDigest) {
        throw new CheckpointConflictError(`Checkpoint ${record.checkpointId} has no sealed postimage.`);
      }
      return {
        record,
        before: await this.dependencies.getManifest(record.preManifestDigest),
        after: await this.dependencies.getManifest(record.postManifestDigest)
      };
    }));
  }
}
