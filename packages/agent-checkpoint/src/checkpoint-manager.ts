import { randomUUID } from "node:crypto";
import {
  mkdir, readFile, readdir
} from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile } from "agent-platform";
import type {
  CheckpointManagerOptions,
  CheckpointManifest,
  CheckpointRecord,
  CreateCheckpointInput,
  OpenCheckpointInspection,
  SealedCheckpointInspection
} from "./types.js";
import { CheckpointConflictError } from "./types.js";
import { checkpointDelta } from "./manifest.js";
import { normalizeCheckpointScopes, safeCheckpointId as safeId } from "./path-safety.js";
import { restoreCheckpointTransaction } from "./restore-transaction.js";
import { recoverCheckpointTransactions } from "./restore-recovery.js";
import { captureCheckpointManifest } from "./safe-capture.js";
import { CheckpointCasStore } from "./cas-store.js";
import { buildCheckpointReview } from "./checkpoint-review.js";

export { checkpointDelta } from "./manifest.js";
export class CheckpointManager {
  private readonly rootDir: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly excludedNames: ReadonlySet<string>;
  private readonly restoreFaultInjector: CheckpointManagerOptions["restoreFaultInjector"];
  private readonly cas: CheckpointCasStore;
  constructor(options: CheckpointManagerOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxFiles = options.maxFiles ?? 250_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.excludedNames = new Set(options.excludedNames ?? [".git", ".agent"]);
    this.restoreFaultInjector = options.restoreFaultInjector;
    this.cas = new CheckpointCasStore(this.rootDir);
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
    const pre = await this.capture(workspacePath, scopePaths);
    const preManifestDigest = await this.putManifest(pre);
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
      preManifestDigest
    };
    await this.writeRecord(record);
    return record;
  }
  async seal(
    sessionId: string,
    checkpointId: string,
    expectedCurrentManifestDigest?: string
  ): Promise<CheckpointRecord> {
    let record = await this.readRecord(sessionId, checkpointId);
    await this.recover(record.workspacePath);
    record = await this.readRecord(sessionId, checkpointId);
    if (record.status !== "open") throw new Error(`Checkpoint ${checkpointId} is not open.`);
    await this.assertLatestUnresolved(sessionId, checkpointId, "open");
    const before = await this.getManifest(record.preManifestDigest);
    const after = await this.capture(record.workspacePath, record.scopePaths);
    const postManifestDigest = await this.putManifest(after);
    if (expectedCurrentManifestDigest !== undefined && postManifestDigest !== expectedCurrentManifestDigest) {
      throw new CheckpointConflictError(
        `Workspace changed after checkpoint ${checkpointId} recovery was offered; keep was not started.`
      );
    }
    const sealed: CheckpointRecord = {
      ...record,
      status: "sealed",
      sealedAt: new Date().toISOString(),
      postManifestDigest,
      delta: checkpointDelta(before, after)
    };
    await this.writeRecord(sealed);
    return sealed;
  }
  async list(sessionId: string): Promise<CheckpointRecord[]> {
    const directory = this.sessionDirectory(sessionId);
    const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    const records = await Promise.all(names.map(async (name) =>
      await this.readRecord(sessionId, name.slice(0, -5))));
    return records.sort((left, right) => left.baseSeq - right.baseSeq
      || left.createdAt.localeCompare(right.createdAt)
      || left.checkpointId.localeCompare(right.checkpointId));
  }
  async inspectOpen(sessionId: string, checkpointId: string): Promise<OpenCheckpointInspection> {
    let checkpoint = await this.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "open") throw new Error(`Checkpoint ${checkpointId} is not open.`);
    const before = await this.getManifest(checkpoint.preManifestDigest);
    const current = await this.capture(checkpoint.workspacePath, checkpoint.scopePaths);
    const currentManifestDigest = await this.putManifest(current);
    return {
      checkpoint,
      currentManifestDigest,
      changed: currentManifestDigest !== checkpoint.preManifestDigest,
      delta: checkpointDelta(before, current)
    };
  }
  async inspectSealed(sessionId: string, checkpointId: string): Promise<SealedCheckpointInspection> {
    let checkpoint = await this.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "sealed" || !checkpoint.postManifestDigest) {
      throw new Error(`Checkpoint ${checkpointId} is not sealed.`);
    }
    const current = await this.capture(checkpoint.workspacePath, checkpoint.scopePaths);
    const currentManifestDigest = await this.putManifest(current);
    return {
      checkpoint,
      currentManifestDigest,
      changed: currentManifestDigest !== checkpoint.postManifestDigest
    };
  }
  async reviewDiff(sessionId: string, checkpointId: string, maxBytes = 256 * 1024): Promise<string> {
    let checkpoint = await this.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "sealed" || !checkpoint.postManifestDigest || !checkpoint.delta) {
      throw new Error(`Checkpoint ${checkpointId} is not sealed for review.`);
    }
    const before = await this.getManifest(checkpoint.preManifestDigest);
    const after = await this.getManifest(checkpoint.postManifestDigest);
    return await buildCheckpointReview(checkpoint, before, after, this.cas, maxBytes);
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
    const current = await this.capture(latest.workspacePath, latest.scopePaths);
    const currentDigest = await this.putManifest(current);
    if (currentDigest !== latest.postManifestDigest) {
      throw new CheckpointConflictError(
        `Workspace no longer matches checkpoint ${latest.checkpointId} postimage; undo was not started.`
      );
    }
    const before = await this.getManifest(latest.preManifestDigest);
    const after = await this.getManifest(latest.postManifestDigest);
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
    let checkpoint = await this.readRecord(sessionId, checkpointId);
    await this.recover(checkpoint.workspacePath);
    checkpoint = await this.readRecord(sessionId, checkpointId);
    if (checkpoint.status !== "open") throw new Error(`Checkpoint ${checkpointId} is not open.`);
    await this.assertLatestUnresolved(sessionId, checkpointId, "open");
    const before = await this.getManifest(checkpoint.preManifestDigest);
    const current = await this.capture(checkpoint.workspacePath, checkpoint.scopePaths);
    const currentManifestDigest = await this.putManifest(current);
    if (currentManifestDigest !== expectedCurrentManifestDigest) {
      throw new CheckpointConflictError(
        `Workspace changed after checkpoint ${checkpointId} recovery was offered; restore was not started.`
      );
    }
    const restored: CheckpointRecord = {
      ...checkpoint,
      status: "restored",
      restoredAt: new Date().toISOString(),
      postManifestDigest: currentManifestDigest,
      delta: checkpointDelta(before, current)
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
    ignoredRootName?: string
  ): Promise<CheckpointManifest> {
    return await captureCheckpointManifest({
      workspacePath,
      scopePaths,
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      excludedNames: this.excludedNames,
      ...(ignoredRootName ? { ignoredRootName } : {}),
      putCas: async (content) => await this.cas.putStream(content)
    });
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
      desired,
      current,
      readCas: (digest) => this.cas.stream(digest),
      capture: async (ignoredRootName) => await this.capture(workspacePath, scopePaths, ignoredRootName),
      finalization: { record: restored, desiredManifestDigest: restored.preManifestDigest },
      finalize: async () => await this.writeRecord(restored),
      ...(this.restoreFaultInjector ? { faultInjector: this.restoreFaultInjector } : {})
    });
  }

  private sessionDirectory(sessionId: string): string {
    return path.join(this.rootDir, "checkpoints", "sessions", safeId(sessionId, "session identifier"));
  }

  private recordPath(sessionId: string, checkpointId: string): string {
    return path.join(this.sessionDirectory(sessionId), `${safeId(checkpointId, "checkpoint identifier")}.json`);
  }

  private async writeRecord(record: CheckpointRecord): Promise<void> {
    const target = this.recordPath(record.sessionId, record.checkpointId);
    await mkdir(path.dirname(target), { recursive: true });
    await durableReplaceFile(target, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  private async readRecord(sessionId: string, checkpointId: string): Promise<CheckpointRecord> {
    return JSON.parse(await readFile(this.recordPath(sessionId, checkpointId), "utf8")) as CheckpointRecord;
  }

  private async putManifest(manifest: CheckpointManifest): Promise<string> {
    return await this.cas.putBytes(Buffer.from(JSON.stringify(manifest), "utf8"));
  }

  private async getManifest(digest: string): Promise<CheckpointManifest> {
    return JSON.parse((await this.cas.readVerifiedAll(digest)).toString("utf8")) as CheckpointManifest;
  }

  private async recover(workspacePath: string): Promise<void> {
    const canonical = path.resolve(workspacePath);
    await recoverCheckpointTransactions({
      workspacePath: canonical,
      finalize: async ({ record, desiredManifestDigest }) => {
        if (record.schemaVersion !== 1 || record.status !== "restored"
          || path.resolve(record.workspacePath) !== canonical
          || record.preManifestDigest !== desiredManifestDigest) {
          throw new CheckpointConflictError("Checkpoint recovery finalization identity is invalid.");
        }
        // Recompute the target through validated identifiers; never trust a path from the workspace journal.
        this.recordPath(record.sessionId, record.checkpointId);
        const current = await this.capture(canonical, record.scopePaths);
        const currentDigest = await this.putManifest(current);
        if (currentDigest !== desiredManifestDigest) {
          throw new CheckpointConflictError("Verified checkpoint recovery no longer matches its desired manifest.");
        }
        await this.writeRecord(record);
      }
    });
  }
}
