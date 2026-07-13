import {
  createCheckpointManagerForTesting,
  type CheckpointRestoreFaultInjector
} from "agent-checkpoint/testing";
import { InProcessRuntimeClient } from "./runtime-client.js";
import type { CreateRuntimeOptions } from "./create-runtime.js";

export type { CheckpointRestoreFaultEvent, CheckpointRestoreFaultInjector } from "agent-checkpoint/testing";

// Internal test support is intentionally isolated from the production package root.
export * from "./types.js";
export * from "./runtime-client.js";
export * from "./create-runtime.js";
export * from "./session-command-bus.js";
export * from "./restore-session.js";
export * from "./configured-runtime.js";
export * from "./composition-supervision.js";
export * from "./durable-children.js";
export * from "./child-workspace-recovery.js";
export * from "./workspace-mcp-trust.js";
export * from "./workspace-customization-trust.js";
export * from "./runtime-state.js";
export * from "./runtime-session-state.js";
export * from "./customization.js";
export * from "./hook-runner.js";
export * from "./frozen-hook-assets.js";
export * from "./frozen-skill-assets.js";
export * from "./agent-profile-hook-runner.js";
export * from "./runtime-hooks.js";

export function createRuntimeForTesting(
  options: CreateRuntimeOptions,
  checkpointRestoreFaultInjector?: CheckpointRestoreFaultInjector
): InProcessRuntimeClient {
  const checkpointManager = checkpointRestoreFaultInjector
    ? createCheckpointManagerForTesting({
      rootDir: options.storeRootDir,
      maxFiles: options.checkpointMaxFiles,
      maxBytes: options.checkpointMaxBytes
    }, checkpointRestoreFaultInjector)
    : undefined;
  return new InProcessRuntimeClient(options, checkpointManager ? { checkpointManager } : {});
}
