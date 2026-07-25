import type { RunOutcome } from "agent-protocol";
import { mutationFrontierHasChanges } from "agent-kernel";
import { deadlineForecast } from "./convergence-policy.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { LongHorizonCoordinator } from "./long-horizon-coordinator.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import type { RuntimeSession } from "./types.js";
import { completionReviewBlocker } from "./completion-evidence-gate.js";
import { settleBudgetBoundaryProcesses } from "./process-budget-settlement.js";

interface SolvingBudgetBoundaryOptions {
  reviews: ReviewCoordinator;
  longHorizon: LongHorizonCoordinator;
  emit: EffectRunnerOptions["emit"];
  finish: EffectRunnerOptions["finish"];
  runtime: EffectRunnerOptions["runtime"];
  createArtifact: EffectRunnerOptions["createArtifact"];
}

function isOrdinaryBudgetExhaustion(outcome: RunOutcome): boolean {
  return outcome.kind === "recoverable_failure"
    && outcome.code === "budget_exhausted";
}

function lastAssistantText(session: RuntimeSession): string | undefined {
  return [...session.durable.state.messages].reverse()
    .find((message) =>
      message.role === "assistant" && message.content.trim().length > 0)
    ?.content.trim();
}

/**
 * The ordinary solver and the assurance pool are separate resource domains.
 * Exhausting the former after a mutation transfers control to independent
 * verification; only an actual outer deadline bypasses that transfer.
 */
export async function finishSolvingBudgetBoundary(
  session: RuntimeSession,
  signal: AbortSignal,
  outcome: RunOutcome,
  options: SolvingBudgetBoundaryOptions
): Promise<boolean> {
  if (!isOrdinaryBudgetExhaustion(outcome)
    || deadlineForecast(session).stage !== "normal"
    || !mutationFrontierHasChanges(session.durable.state.mutationFrontier)) {
    return await options.finish(session, outcome);
  }
  await settleBudgetBoundaryProcesses(session, signal, {
    execution: options.runtime.execution,
    emit: options.emit,
    createArtifact: options.createArtifact
  });
  if (completionReviewBlocker(session)) {
    return await options.finish(session, outcome);
  }
  await options.reviews.maybeReview(session, signal, true, "completion");
  await options.longHorizon.accountReview(session);
  const message = lastAssistantText(session)
    ?? "The ordinary solving budget ended after workspace changes; the current result was submitted to independent verification.";
  await options.emit(session, "diagnostic", "runtime", {
    kind: "assurance.review_transfer",
    sourceOutcomeCode: "budget_exhausted",
    message,
    decisionAuthority: "resource_boundary"
  });
  return await options.finish(session, {
    kind: "completed",
    message,
    evidence: [...session.durable.state.evidence]
  }, session.durable.state.revision);
}
