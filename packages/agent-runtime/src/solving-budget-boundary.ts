import type { RunOutcome } from "agent-protocol";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";
import {
  settleBudgetBoundaryProcesses,
  terminateUnhandedBudgetBoundaryProcesses
} from "./process-budget-settlement.js";

interface SolvingBudgetBoundaryOptions {
  emit: EffectRunnerOptions["emit"];
  finish: EffectRunnerOptions["finish"];
  runtime: EffectRunnerOptions["runtime"];
  createArtifact: EffectRunnerOptions["createArtifact"];
}

function isOrdinaryBudgetExhaustion(outcome: RunOutcome): boolean {
  return outcome.kind === "recoverable_failure"
    && outcome.code === "budget_exhausted";
}

/**
 * A hard-ledger boundary is recoverable, but it is not successful completion.
 * Settle owned work and preserve partial workspace state before propagating the
 * original typed failure. The caller can then distinguish an interrupted run
 * from a naturally completed one and decide whether to resume it.
 */
export async function finishSolvingBudgetBoundary(
  session: RuntimeSession,
  signal: AbortSignal,
  outcome: RunOutcome,
  options: SolvingBudgetBoundaryOptions
): Promise<boolean> {
  if (!isOrdinaryBudgetExhaustion(outcome)) {
    return await options.finish(session, outcome);
  }
  await settleBudgetBoundaryProcesses(session, signal, {
    execution: options.runtime.execution,
    emit: options.emit,
    createArtifact: options.createArtifact
  });
  await terminateUnhandedBudgetBoundaryProcesses(session, signal, {
    execution: options.runtime.execution,
    emit: options.emit,
    createArtifact: options.createArtifact
  });
  return await options.finish(session, outcome);
}
