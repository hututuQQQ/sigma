import { CheckpointManager } from "./checkpoint-manager.js";
import type { CheckpointManagerOptions } from "./types.js";
import type { CheckpointRestoreFaultInjector } from "./fault-injection.js";

export type {
  CheckpointRestoreFaultEvent,
  CheckpointRestoreFaultInjector,
  CheckpointRestoreFaultPoint
} from "./fault-injection.js";

export function createCheckpointManagerForTesting(
  options: CheckpointManagerOptions,
  restoreFaultInjector: CheckpointRestoreFaultInjector
): CheckpointManager {
  return new CheckpointManager(options, restoreFaultInjector);
}
