import type { ContentAddressedArtifactStore } from "agent-store";
import { restoreRuntimeCustomization } from "./runtime-customization-restore.js";
import { hydrateRuntimeSession } from "./runtime-session-restore.js";
import type { OpenCheckpointRecoveryResult } from "./runtime-control-contracts.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

export interface RuntimeSessionResumeOptions {
  runtime: RuntimeOptions;
  artifacts: ContentAddressedArtifactStore;
  runDeadlineMs: number;
  bind(session: RuntimeSession): Promise<void>;
  accept(session: RuntimeSession): void;
  recoverOpen(session: RuntimeSession): Promise<OpenCheckpointRecoveryResult>;
  suspend(checkpointId: string, currentManifestDigest: string, session: RuntimeSession): Promise<void>;
  recover(session: RuntimeSession): Promise<void>;
}

export async function resumeRuntimeSession(
  sessionId: string,
  options: RuntimeSessionResumeOptions
): Promise<void> {
  const session = await hydrateRuntimeSession(
    options.runtime.store,
    sessionId,
    options.runDeadlineMs,
    {
      gateway: options.runtime.gateway,
      profile: options.runtime.profile,
      profileSource: options.runtime.profileSource
    },
    options.runtime.runtimeEnvironment
  );
  await restoreRuntimeCustomization(session, options.artifacts, options.runtime);
  await options.bind(session);
  options.accept(session);
  const recovery = await options.recoverOpen(session);
  if (recovery.kind === "needs_input") {
    await options.suspend(recovery.checkpointId, recovery.currentManifestDigest, session);
    return;
  }
  await options.recover(session);
}
