import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import { semanticActionDebt } from "agent-kernel";
import type { RuntimeSession } from "./types.js";
import { completionLimitations, reviewSatisfied } from "./completion-limitations.js";
import { frontierValidationReadiness } from "./mutation-evidence.js";
import { candidateReviewEligible } from "./review-eligibility.js";

export const ACTION_SETTLEMENT_GRACE_MS = 10_000;
const MODEL_MINIMUM_MS = 15_000;
const MODEL_MAXIMUM_MS = 180_000;
const CONVERGENCE_MODEL_MAXIMUM_MS = 120_000;
const CONVERGENCE_OUTPUT_TOKENS = 4_096;
const TOOL_MINIMUM_MS = 250;
const TOOL_MAXIMUM_MS = 180_000;
const TOOL_FALLBACK_MS = 5_000;
const PROCESS_CLEANUP_MS = 10_000;
const TERMINAL_ATTEMPT_WINDOWS = 2;

export type ConvergenceAction =
  | {
    kind: "model";
    stage?: "normal" | "converge" | "terminal";
    futureBudgetReserve?: Partial<BudgetAmounts>;
  }
  | { kind: "tool"; count: number; terminalOnly?: boolean };

export interface ConvergenceAdmissionDecision {
  failure: RunOutcome;
  reason: "budget" | "deadline";
  forecast?: DeadlineForecast;
}

function quantile(values: readonly number[], fraction: number, fallback: number): number {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (finite.length === 0) return fallback;
  return finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * fraction) - 1))]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function modelEstimateMs(session: RuntimeSession): number {
  const samples = session.durable.state.usage
    .filter((item) => item.runId === session.durable.runId
      && item.role === session.services.modelRole)
    .slice(-8)
    .map((item) => item.latencyMs);
  return clamp(Math.ceil(quantile(samples, 0.90, MODEL_MINIMUM_MS / 1.5) * 1.5), MODEL_MINIMUM_MS, MODEL_MAXIMUM_MS);
}

function convergenceModelEstimateMs(session: RuntimeSession, normalEstimateMs: number): number {
  const samples = session.durable.state.usage
    .filter((item) => item.runId === session.durable.runId
      && item.role === session.services.modelRole
      && item.outputTokens <= CONVERGENCE_OUTPUT_TOKENS)
    .slice(-8)
    .map((item) => item.latencyMs);
  if (samples.length === 0) {
    return Math.min(normalEstimateMs, CONVERGENCE_MODEL_MAXIMUM_MS);
  }
  return clamp(
    Math.ceil(quantile(samples, 0.90, MODEL_MINIMUM_MS / 1.25) * 1.25),
    MODEL_MINIMUM_MS,
    CONVERGENCE_MODEL_MAXIMUM_MS
  );
}

function reviewerEstimateMs(session: RuntimeSession, fallback: number): number {
  const samples = session.durable.state.usage
    .filter((item) => item.runId === session.durable.runId && item.role === "reviewer")
    .slice(-8)
    .map((item) => item.latencyMs);
  return clamp(
    Math.ceil(quantile(samples, 0.90, fallback / 1.25) * 1.25),
    MODEL_MINIMUM_MS,
    MODEL_MAXIMUM_MS
  );
}

function toolEstimateMs(session: RuntimeSession, terminalOnly: boolean): number {
  if (terminalOnly) return TOOL_MINIMUM_MS;
  const samples = session.durable.state.receipts.slice(-8).flatMap((receipt) => {
    const started = Date.parse(receipt.startedAt);
    const completed = Date.parse(receipt.completedAt);
    return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
      ? [completed - started] : [];
  });
  return clamp(
    Math.ceil(quantile(samples, 0.90, TOOL_FALLBACK_MS / 1.5) * 1.5),
    TOOL_MINIMUM_MS,
    TOOL_MAXIMUM_MS
  );
}

export type DeadlineStage = "normal" | "converge" | "stop";
export type ConvergenceBudgetStage = "normal" | "converge" | "terminal";

export interface DeadlineForecast {
  stage: DeadlineStage;
  remainingMs: number;
  usableMs: number;
  nextModelEstimateMs: number;
  nextConvergenceModelEstimateMs: number;
  nextToolEstimateMs: number;
  reviewerEstimateMs: number;
  processCleanupReserveMs: number;
  observedCycleEstimateMs: number;
  terminalActionReserveMs: number;
  terminalStageReserveMs: number;
  terminalProjectionThresholdMs: number;
  settlementReserveMs: number;
  obligations: string[];
  actionDebt: number;
}

interface ConvergenceStageLatch {
  runId: string;
  deadline: DeadlineStage;
  budget: ConvergenceBudgetStage;
}

const sessionStageLatches = new WeakMap<RuntimeSession, ConvergenceStageLatch>();
const forecastStageLatches = new WeakMap<DeadlineForecast, ConvergenceStageLatch>();
const DEADLINE_STAGE_RANK: Record<DeadlineStage, number> = { normal: 0, converge: 1, stop: 2 };
const BUDGET_STAGE_RANK: Record<ConvergenceBudgetStage, number> = { normal: 0, converge: 1, terminal: 2 };

function stageLatch(session: RuntimeSession): ConvergenceStageLatch {
  const existing = sessionStageLatches.get(session);
  if (existing?.runId === session.durable.runId) return existing;
  const durable = session.durable.state.convergenceStageHighWater;
  const created: ConvergenceStageLatch = {
    runId: session.durable.runId,
    deadline: durable?.runId === session.durable.runId ? durable.deadline : "normal",
    budget: durable?.runId === session.durable.runId ? durable.budget : "normal"
  };
  sessionStageLatches.set(session, created);
  return created;
}

function monotonicDeadlineStage(latch: ConvergenceStageLatch, requested: DeadlineStage): DeadlineStage {
  if (DEADLINE_STAGE_RANK[requested] > DEADLINE_STAGE_RANK[latch.deadline]) latch.deadline = requested;
  return latch.deadline;
}

/** The forecast carries a runtime-local capacity/deadline latch. It is
 * deliberately not serialized: a new run receives a fresh latch, while hard
 * resource pressure in the same live run can only move toward settlement.
 * Action debt is intentionally not passed here because trusted semantic
 * progress must be able to return it to normal. */
export function monotonicBudgetStage(
  forecast: DeadlineForecast,
  requested: ConvergenceBudgetStage
): ConvergenceBudgetStage {
  const latch = forecastStageLatches.get(forecast);
  if (!latch) return requested;
  if (BUDGET_STAGE_RANK[requested] > BUDGET_STAGE_RANK[latch.budget]) latch.budget = requested;
  return latch.budget;
}

function addObligation(target: string[], required: boolean, name: string): void {
  if (required) target.push(name);
}

function planIncomplete(session: RuntimeSession): boolean {
  return session.durable.state.plan.nodes.some((node) =>
    node.status !== "completed" && node.status !== "cancelled");
}

function checkpointUnsettled(session: RuntimeSession): boolean {
  return session.durable.state.checkpointHead?.status === "open"
    || session.recovery.openCheckpointRecovery !== undefined;
}

function requiredReviewIncomplete(session: RuntimeSession, changed: boolean): boolean {
  return changed && !reviewSatisfied(session);
}

function observedConvergenceCycleMs(session: RuntimeSession): number {
  const allModel = session.durable.state.usage.filter((item) => item.runId === session.durable.runId
    && item.role === session.services.modelRole);
  const focused = allModel.filter((item) => item.outputTokens <= CONVERGENCE_OUTPUT_TOKENS);
  const modelSamples = (focused.length > 0 ? focused : allModel).slice(-8).map((item) => item.latencyMs);
  const toolSamples = session.durable.state.receipts.slice(-8).flatMap((receipt) => {
    const started = Date.parse(receipt.startedAt);
    const completed = Date.parse(receipt.completedAt);
    return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
      ? [completed - started] : [];
  });
  const modelMs = modelSamples.length > 0
    ? clamp(Math.ceil(quantile(modelSamples, 0.90, 0) * 1.25), 0, CONVERGENCE_MODEL_MAXIMUM_MS) : 0;
  const toolMs = toolSamples.length > 0
    ? clamp(Math.ceil(quantile(toolSamples, 0.90, 0) * 1.5), 0, TOOL_MAXIMUM_MS) : 0;
  return modelMs + toolMs;
}

function reviewerWillRunAtFinalize(session: RuntimeSession): boolean {
  return candidateReviewEligible(session);
}

/** A workspace review or a review bound to an older completion message cannot
 * cover the completion candidate that the next model request has not produced
 * yet. Keep one model-request window available for that future candidate-bound
 * review whenever finalization can reach the reviewer. */
export function candidateReviewerRequestReserve(session: RuntimeSession): 0 | 1 {
  return reviewerWillRunAtFinalize(session) ? 1 : 0;
}

export function convergenceObligations(session: RuntimeSession): string[] {
  const state = session.durable.state;
  const changed = state.mutationFrontier.changedPaths.length > 0;
  const limitationReady = changed && completionLimitations(session) !== null;
  const validationReady = !changed || frontierValidationReadiness(session).ready || limitationReady;
  const obligations: string[] = [];
  addObligation(obligations, planIncomplete(session), "plan_incomplete");
  addObligation(obligations, state.activeProcessIds.length > 0, "active_processes");
  addObligation(obligations, checkpointUnsettled(session), "checkpoint_unsettled");
  addObligation(obligations, !validationReady, "validation_incomplete");
  addObligation(obligations, requiredReviewIncomplete(session, changed), "review_incomplete");
  addObligation(obligations, state.completionRepair !== undefined, "completion_repair");
  return obligations;
}

export function deadlineForecast(session: RuntimeSession, now = Date.now()): DeadlineForecast {
  const remainingMs = session.durable.state.deadlineRemainingMs
    ?? Date.parse(session.durable.state.deadlineAt) - now;
  const nextModelEstimateMs = modelEstimateMs(session);
  const nextConvergenceModelEstimateMs = convergenceModelEstimateMs(session, nextModelEstimateMs);
  const nextToolEstimateMs = toolEstimateMs(session, false);
  const reviewPending = reviewerWillRunAtFinalize(session);
  const reviewerReserveMs = reviewPending
    ? reviewerEstimateMs(session, nextConvergenceModelEstimateMs)
    : 0;
  const processCleanupReserveMs = session.durable.state.activeProcessIds.length * PROCESS_CLEANUP_MS;
  const observedCycleEstimateMs = observedConvergenceCycleMs(session);
  const settlementReserveMs = ACTION_SETTLEMENT_GRACE_MS + processCleanupReserveMs;
  // Natural model completion is reduced into a runtime-owned terminal tool.
  // Reserve one complete pair for ordinary admission, and two pairs before
  // projecting terminal-only tools so one rejected completion can still be
  // repaired into a typed blocked/input outcome without racing the deadline.
  const terminalActionReserveMs = nextConvergenceModelEstimateMs
    + TOOL_MINIMUM_MS + reviewerReserveMs + settlementReserveMs;
  const terminalStageReserveMs = terminalActionReserveMs * TERMINAL_ATTEMPT_WINDOWS;
  // Switch tool projection before one more focused model/tool cycle could eat
  // the two-attempt terminal reserve. Admission repeats the same check at the
  // exact action boundary, so latency overruns cannot silently borrow it.
  const terminalProjectionThresholdMs = terminalStageReserveMs + observedCycleEstimateMs;
  const usableMs = Math.max(0, remainingMs - settlementReserveMs);
  const obligations = convergenceObligations(session);
  // Three model windows remains the normal minimum. Each distinct unfinished
  // obligation beyond that reserves one additional model window so validation,
  // review, process cleanup, and terminal settlement begin before the deadline
  // race. This is a forecast only, never a global turn or step limit.
  const convergeModelWindows = Math.max(3, obligations.length + 1);
  const convergenceThresholdMs = Math.max(
    nextModelEstimateMs * convergeModelWindows + settlementReserveMs,
    terminalProjectionThresholdMs
  );
  const requestedStage: DeadlineStage = remainingMs < terminalActionReserveMs
    ? "stop"
    : remainingMs < convergenceThresholdMs ? "converge" : "normal";
  const latch = stageLatch(session);
  const forecast: DeadlineForecast = {
    stage: monotonicDeadlineStage(latch, requestedStage),
    remainingMs,
    usableMs,
    nextModelEstimateMs,
    nextConvergenceModelEstimateMs,
    nextToolEstimateMs,
    reviewerEstimateMs: reviewerReserveMs,
    processCleanupReserveMs,
    observedCycleEstimateMs,
    terminalActionReserveMs,
    terminalStageReserveMs,
    terminalProjectionThresholdMs,
    settlementReserveMs,
    obligations,
    actionDebt: semanticActionDebt(session.durable.state)
  };
  forecastStageLatches.set(forecast, latch);
  return forecast;
}

function usedBudget(session: RuntimeSession, dimension: keyof BudgetAmounts): number {
  const ledger = session.durable.state.budget;
  return ledger.consumed[dimension] + ledger.reserved[dimension];
}

function availableBudget(session: RuntimeSession, dimension: keyof BudgetAmounts): number {
  return Math.max(0, session.durable.state.budget.limits[dimension] - usedBudget(session, dimension));
}

function budgetFailure(message: string): RunOutcome {
  return { kind: "recoverable_failure", code: "budget_exhausted", message };
}

function hardBudgetFailure(session: RuntimeSession, action: ConvergenceAction): RunOutcome | null {
  if (action.kind === "tool") {
    const available = availableBudget(session, "toolCalls");
    return action.count > available
      ? budgetFailure(`The next tool batch requires ${action.count} calls but only ${available} tool-call budget remains.`)
      : null;
  }
  const reviewerTurns = action.futureBudgetReserve?.modelTurns ?? 0;
  const availableTurns = availableBudget(session, "modelTurns");
  if (availableTurns <= reviewerTurns) {
    return budgetFailure(reviewerTurns > 0
      ? "The remaining model-turn budget is reserved for the candidate-bound reviewer; another solver turn cannot be admitted."
      : "No modelTurns budget remains for another model turn.");
  }
  const dimensions: Array<keyof BudgetAmounts> = ["inputTokens", "outputTokens", "modelTurns"];
  const exhausted = dimensions.find((dimension) => availableBudget(session, dimension) < 1);
  return exhausted
    ? budgetFailure(`No ${exhausted} budget remains for another model turn.`)
    : null;
}

/**
 * Admit a model/tool action against the same durable budget and active-time
 * view. Hard reservations still perform exact accounting; this forecast only
 * prevents beginning work that cannot reasonably settle before the outer
 * deadline, so the run can commit a normal typed failure instead of crashing
 * in the deadline race.
 */
export function convergenceAdmissionDecision(
  session: RuntimeSession,
  action: ConvergenceAction,
  now = Date.now()
): ConvergenceAdmissionDecision | null {
  const hardFailure = hardBudgetFailure(session, action);
  if (hardFailure) return { failure: hardFailure, reason: "budget" };
  const forecast = deadlineForecast(session, now);
  const remainingMs = forecast.remainingMs;
  const modelStage = action.kind === "model"
    ? action.stage ?? (forecast.stage === "normal" ? "normal" : "converge")
    : undefined;
  const estimateMs = action.kind === "model"
    ? modelStage === "normal" ? forecast.nextModelEstimateMs : forecast.nextConvergenceModelEstimateMs
    : toolEstimateMs(session, action.terminalOnly === true);
  // A non-terminal tool must leave enough active time for one complete bounded
  // terminal action. The two-attempt reserve controls when projection hides
  // ordinary tools; charging it again here would expose an action that cannot
  // be admitted in the narrow converge window.
  const terminalExtrasMs = Math.max(
    0,
    forecast.terminalActionReserveMs - forecast.nextConvergenceModelEstimateMs
  );
  const requiredMs = action.kind === "model"
    ? modelStage === "terminal"
      ? estimateMs + terminalExtrasMs
      : estimateMs + forecast.nextToolEstimateMs + forecast.terminalActionReserveMs
    : action.terminalOnly === true
      ? estimateMs + forecast.reviewerEstimateMs + forecast.settlementReserveMs
      : estimateMs + forecast.terminalActionReserveMs;
  if (remainingMs > requiredMs) return null;
  return {
    failure: budgetFailure(
      `Only ${Math.max(0, Math.floor(remainingMs))}ms of active time remains; the next ${action.kind} action and durable settlement require approximately ${requiredMs}ms. Stopped before the hard deadline.`
    ),
    reason: "deadline",
    forecast
  };
}

export function convergenceAdmissionFailure(
  session: RuntimeSession,
  action: ConvergenceAction,
  now = Date.now()
): RunOutcome | null {
  return convergenceAdmissionDecision(session, action, now)?.failure ?? null;
}
