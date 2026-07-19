import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile } from "agent-platform";
import { CheckpointCasStore } from "./cas-store.js";
import {
  CheckpointManifestMerkleCaptureWriter,
  putCheckpointDeltaMerkle,
  putCheckpointManifestMerkle,
  readCheckpointDeltaMerkle,
  readCheckpointManifestMerkle
} from "./manifest-store.js";
import { checkpointDeltaFromMerkle } from "./manifest-stream-delta.js";
import { captureCheckpointEntries, type CaptureOptions } from "./safe-capture.js";
import { safeCheckpointId as safeId } from "./path-safety.js";
import {
  CheckpointConflictError,
  isCheckpointRecord,
  type CheckpointDelta,
  type CheckpointManifest,
  type CheckpointRecord
} from "./types.js";

export class CheckpointStateStore {
  readonly cas: CheckpointCasStore;

  constructor(private readonly rootDir: string) {
    this.cas = new CheckpointCasStore(rootDir);
  }

  sessionDirectory(sessionId: string): string {
    return path.join(this.rootDir, "checkpoints", "sessions", safeId(sessionId, "session identifier"));
  }

  recordPath(sessionId: string, checkpointId: string): string {
    return path.join(
      this.sessionDirectory(sessionId),
      `${safeId(checkpointId, "checkpoint identifier")}.json`
    );
  }

  async writeRecord(record: CheckpointRecord): Promise<void> {
    const target = this.recordPath(record.sessionId, record.checkpointId);
    await mkdir(path.dirname(target), { recursive: true });
    await durableReplaceFile(target, JSON.stringify(this.persistedRecord(record), null, 2), { mode: 0o600 });
  }

  async readRecord(sessionId: string, checkpointId: string): Promise<CheckpointRecord> {
    const value: unknown = JSON.parse(await readFile(this.recordPath(sessionId, checkpointId), "utf8"));
    if (!isCheckpointRecord(value) || value.sessionId !== sessionId || value.checkpointId !== checkpointId) {
      throw new CheckpointConflictError("Persisted checkpoint record is invalid.");
    }
    if (value.deltaDigest && !value.delta) {
      return { ...value, delta: await readCheckpointDeltaMerkle(this.cas, value.deltaDigest) };
    }
    return value;
  }

  async putManifest(manifest: CheckpointManifest): Promise<string> {
    return await putCheckpointManifestMerkle(this.cas, manifest);
  }

  async captureManifest(options: Omit<CaptureOptions, "putCas">): Promise<string> {
    const writer = new CheckpointManifestMerkleCaptureWriter(this.cas);
    const summary = await captureCheckpointEntries(
      { ...options, putCas: async (content) => await this.cas.putStream(content) },
      async (entry) => await writer.add(entry)
    );
    return await writer.finish(summary);
  }

  async getManifest(digest: string): Promise<CheckpointManifest> {
    return await readCheckpointManifestMerkle(this.cas, digest);
  }

  async putDelta(delta: CheckpointDelta): Promise<string> {
    return await putCheckpointDeltaMerkle(this.cas, delta);
  }

  async deltaBetween(beforeDigest: string, afterDigest: string): Promise<CheckpointDelta> {
    return await checkpointDeltaFromMerkle(this.cas, beforeDigest, afterDigest);
  }

  persistedRecord(record: CheckpointRecord): CheckpointRecord {
    if (!record.deltaDigest) return record;
    const persisted = { ...record };
    delete persisted.delta;
    return persisted;
  }
}
