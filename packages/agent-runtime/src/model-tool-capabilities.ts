import type { ToolDescriptor } from "agent-protocol";
import { sessionSkillProjectionCapabilities, type ModelToolProjectionCapabilities } from "./effect-helpers.js";
import { monotonicBudgetStage, type DeadlineForecast } from "./convergence-policy.js";
import type { BudgetStage } from "./model-budget-convergence.js";
import type { RuntimeSession } from "./types.js";

export function projectedToolCapabilities(
  session: RuntimeSession,
  modelDescriptors: readonly ToolDescriptor[],
  liveSkillDescriptors?: readonly { qualifiedName: string }[]
): ModelToolProjectionCapabilities {
  const capabilities = sessionSkillProjectionCapabilities({
    frozenCustomization: session.durable.frozenCustomization,
    liveSkillDescriptors,
    loadedSkills: session.durable.state.frozenSkills,
    profileSkillNames: session.services.profile?.profile.skills
  });
  const environment = session.services.runtimeEnvironment;
  const verifiedCommands = environment?.executionCapabilitiesVerified
    ? environment.availableRuntimeCommands.map((item) => item.toLowerCase()
      .replace(/\.(?:exe|cmd|bat|ps1)$/u, ""))
    : [];
  return {
    ...capabilities,
    gitAvailable: verifiedCommands.includes("git"),
    lspAvailable: modelDescriptors.some((item) => item.name === "lsp")
      && (environment?.availableLanguageServers?.length ?? 0) > 0
  };
}

export function budgetStageForCapacity(forecast: DeadlineForecast, capacity: number): BudgetStage {
  const requested: BudgetStage = capacity <= 1 || forecast.stage === "stop"
    || forecast.remainingMs <= forecast.terminalProjectionThresholdMs ? "terminal"
    : capacity === 2 || forecast.stage === "converge" || forecast.actionDebt >= 2
      ? "converge"
      : "normal";
  return monotonicBudgetStage(forecast, requested);
}
