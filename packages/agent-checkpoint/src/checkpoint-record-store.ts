import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile } from "agent-platform";
import { safeCheckpointId } from "./path-safety.js";
import {
  CheckpointConflictError,
  isCheckpointRecord,
  type CheckpointRecord
} from "./types.js";

export class CheckpointRecordStore {
  constructor(private readonly rootDir: string) {}

  sessionDirectory(sessionId: string): string {
    return path.join(
      this.rootDir,
      "checkpoints",
      "sessions",
      safeCheckpointId(sessionId, "session identifier")
    );
  }

  recordPath(sessionId: string, checkpointId: string): string {
    return path.join(
      this.sessionDirectory(sessionId),
      `${safeCheckpointId(checkpointId, "checkpoint identifier")}.json`
    );
  }

  async write(record: CheckpointRecord): Promise<void> {
    const target = this.recordPath(record.sessionId, record.checkpointId);
    await mkdir(path.dirname(target), { recursive: true });
    await durableReplaceFile(target, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  async writeMany(records: readonly CheckpointRecord[]): Promise<void> {
    for (const record of records) await this.write(record);
  }

  async read(sessionId: string, checkpointId: string): Promise<CheckpointRecord> {
    const value: unknown = JSON.parse(
      await readFile(this.recordPath(sessionId, checkpointId), "utf8")
    );
    if (!isCheckpointRecord(value)
      || value.sessionId !== sessionId
      || value.checkpointId !== checkpointId) {
      throw new CheckpointConflictError("Persisted checkpoint record is invalid.");
    }
    return value;
  }
}
