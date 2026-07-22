import type { CheckpointManager } from "agent-checkpoint";
import type { ContentAddressedArtifactStore } from "agent-store";
import type { BudgetController } from "./budget-controller.js";
import { FrozenSkillMaterializer } from "./frozen-skill-assets.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeOptions } from "./types.js";

export function createRuntimeControlService(
  options: RuntimeOptions & { storeRootDir: string },
  dependencies: {
    checkpoints: CheckpointManager;
    budgets: BudgetController;
    artifacts: ContentAddressedArtifactStore;
    hooks: RuntimeHookCoordinator;
    emit: RuntimeEventEmitter;
  }
): RuntimeControlService {
  const { checkpoints, budgets, artifacts, hooks, emit } = dependencies;
  return new RuntimeControlService({
    checkpoints,
    execution: options.execution,
    skills: options.skills,
    budgets,
    emit,
    createArtifact: async (sessionId, content) => await artifacts.put(sessionId, content),
    readArtifact: async (sessionId, artifactId) => (await artifacts.get(sessionId, artifactId)).toString("utf8"),
    hasActiveChildren: options.hasActiveChildren,
    skillMaterializer: new FrozenSkillMaterializer(options.storeRootDir, artifacts),
    planChanged: async (session, previousRevision, plan) => {
      await hooks.dispatch(session, "plan_changed", {
        previousRevision, plan, source: "tool"
      }, session.execution.controller?.signal ?? new AbortController().signal);
    }
  });
}
