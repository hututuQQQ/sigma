import type { RunOutcome } from "agent-protocol";
import { mutationFrontierHasChanges } from "agent-kernel";
import { deadlineForecast } from "./convergence-policy.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { LongHorizonCoordinator } from "./long-horizon-coordinator.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import type { RuntimeSession } from "./types.js";
import {
  automaticCompletionReviewRequired,
  completionReviewBlocker
} from "./completion-evidence-gate.js";
import {
  settleBudgetBoundaryProcesses,
  terminateUnhandedBudgetBoundaryProcesses
} from "./process-budget-settlement.js";

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
 * A normal hard-ledger boundary is an intentional stop, not a runtime crash.
 * Settle owned work, preserve hard lifecycle invariants, run binding assurance
 * when configured, and submit the current state for external evaluation.
 * Only an elapsed outer deadline bypasses this boundary handoff. The reserved
 * convergence window exists specifically so this settlement can complete.
 */
export async function finishSolvingBudgetBoundary(
  session: RuntimeSession,
  signal: AbortSignal,
  outcome: RunOutcome,
  options: SolvingBudgetBoundaryOptions
): Promise<boolean> {
  if (!isOrdinaryBudgetExhaustion(outcome)
    || deadlineForecast(session).stage === "stop") {
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
  if (completionReviewBlocker(session)) {
    return await options.finish(session, outcome);
  }
  const existingMessage = lastAssistantText(session);
  if (!existingMessage
    && !mutationFrontierHasChanges(session.durable.state.mutationFrontier)) {
    return await options.finish(session, outcome);
  }
  const bindingReview = automaticCompletionReviewRequired(session)
    && mutationFrontierHasChanges(session.durable.state.mutationFrontier);
  if (bindingReview) {
    await options.reviews.maybeReview(session, signal, true, "completion");
    await options.longHorizon.accountReview(session);
  }
  const message = existingMessage
    ?? "The ordinary solving budget ended; the current workspace state was submitted for external evaluation.";
  await options.emit(session, "diagnostic", "runtime", {
    kind: bindingReview
      ? "assurance.review_transfer"
      : "resource_boundary.submission",
    sourceOutcomeCode: "budget_exhausted",
    message,
    decisionAuthority: "resource_boundary"
  });
  return await options.finish(session, {
    kind: "completed",
    message,
    evidence: [...session.durable.state.evidence],
    decisionAuthority: "resource_boundary"
  }, session.durable.state.revision);
}
