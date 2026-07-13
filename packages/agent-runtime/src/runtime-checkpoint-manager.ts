import { CheckpointManager } from "agent-checkpoint";
import type { RuntimeOptions } from "./types.js";

export function createCheckpointManager(options: RuntimeOptions & { storeRootDir: string }): CheckpointManager {
  return new CheckpointManager({
    rootDir: options.storeRootDir,
    maxFiles: options.checkpointMaxFiles,
    maxBytes: options.checkpointMaxBytes
  });
}
