import type { ContentAddressedArtifactStore } from "agent-store";
import type { RuntimeOptions } from "./types.js";
import { RuntimeHookCoordinator } from "./runtime-hooks.js";
import type { ModelAgentProfileHookRunner } from "./agent-profile-hook-runner.js";
import { FrozenWorkspaceHookMaterializer } from "./frozen-hook-assets.js";

type HookCoordinatorOptions = ConstructorParameters<typeof RuntimeHookCoordinator>[0];

export function createRuntimeHooks(
  options: RuntimeOptions & { storeRootDir: string },
  artifacts: ContentAddressedArtifactStore,
  productionProfileRunner: ModelAgentProfileHookRunner | undefined,
  emit: HookCoordinatorOptions["emit"]
): RuntimeHookCoordinator {
  if (options.hooks?.some((hook) => hook.kind === "command") && !options.hookRunner) {
    throw new Error("A hookRunner is required when command hooks are configured.");
  }
  const agentProfileRunner = options.agentProfileHookRunner ?? productionProfileRunner;
  const materializer = new FrozenWorkspaceHookMaterializer(options.storeRootDir, artifacts);
  return new RuntimeHookCoordinator({
    definitions: options.hooks ?? [],
    runner: options.hookRunner ?? {
      run: async () => ({ ok: false, error: "Hook runner is unavailable.", durationMs: 0 })
    },
    ...(agentProfileRunner ? { agentProfileRunner } : {}),
    materializeWorkspaceHook: (session, hook) => materializer.materialize(
      session.identity.workspacePath,
      session.identity.sessionId,
      hook
    ),
    emit
  });
}
