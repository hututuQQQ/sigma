import { ModelAgentProfileHookRunner } from "./agent-profile-hook-runner.js";
import type { BudgetController } from "./budget-controller.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { resolveHookProfile } from "./session-profile.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

export function createProductionProfileRunner(
  options: RuntimeOptions,
  budgets: BudgetController,
  session: (sessionId: string) => RuntimeSession,
  emit: RuntimeEventEmitter
): ModelAgentProfileHookRunner | undefined {
  if (options.agentProfileHookRunner) return undefined;
  return new ModelAgentProfileHookRunner({
    session,
    resolveProfile: (target, profileId) => resolveHookProfile(options, target, profileId),
    gateway: (target, profile) => options.gatewayForRole?.("planner", profile) ?? target.services.gateway,
    budgets,
    emit
  });
}
