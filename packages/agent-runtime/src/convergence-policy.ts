import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export type ConvergenceAction =
  | { kind: "model" }
  | { kind: "tool"; count: number; terminalOnly?: boolean };

export type DeadlineStage = "unbounded" | "normal" | "converge" | "stop";

export interface DeadlineForecast {
  stage: DeadlineStage;
  remainingMs?: number;
  finalizationReserveMs?: number;
}

type BudgetFailure = Extract<RunOutcome, { kind: "recoverable_failure" }>;

const MIN_FINALIZATION_RESERVE_MS = 10_000;
const MAX_FINALIZATION_RESERVE_MS = 120_000;
const MODEL_LATENCY_SAMPLE_LIMIT = 20;

function observedModelLatencyMs(session: RuntimeSession): number | undefined {
  const samples = session.durable.state.usage
    .filter((item) => item.sessionId === session.identity.sessionId
      && item.runId === session.durable.runId
      && item.role === session.services.modelRole
      && Number.isFinite(item.latencyMs)
      && item.latencyMs > 0)
    .slice(-MODEL_LATENCY_SAMPLE_LIMIT)
    .map((item) => item.latencyMs)
    .sort((left, right) => left - right);
  if (samples.length === 0) return undefined;
  const percentileIndex = Math.max(0, Math.ceil(samples.length * 0.9) - 1);
  return samples[percentileIndex];
}

/**
 * Leave enough time for one text-only closeout request plus durable event
 * settlement. The reserve adapts to this session's observed model latency and
 * remains bounded so an explicit task deadline still provides useful work time.
 */
export function deadlineFinalizationReserveMs(session: RuntimeSession): number {
  const observed = observedModelLatencyMs(session) ?? 0;
  return Math.min(
    MAX_FINALIZATION_RESERVE_MS,
    Math.max(MIN_FINALIZATION_RESERVE_MS, Math.ceil(observed) + MIN_FINALIZATION_RESERVE_MS)
  );
}

export function deadlineForecast(session: RuntimeSession, now = Date.now()): DeadlineForecast {
  const paused = session.durable.state.deadlineRemainingMs;
  const finalizationReserveMs = deadlineFinalizationReserveMs(session);
  if (paused !== undefined) {
    return {
      stage: paused <= 0
        ? "stop"
        : paused <= finalizationReserveMs ? "converge" : "normal",
      remainingMs: paused,
      finalizationReserveMs
    };
  }
  const deadlineAt = session.durable.state.deadlineAt;
  if (deadlineAt === undefined) return { stage: "unbounded" };
  const remainingMs = Date.parse(deadlineAt) - now;
  return {
    stage: remainingMs <= 0
      ? "stop"
      : remainingMs <= finalizationReserveMs ? "converge" : "normal",
    remainingMs,
    finalizationReserveMs
  };
}

function usedBudget(session: RuntimeSession, dimension: keyof BudgetAmounts): number {
  const ledger = session.durable.state.budget;
  return ledger.consumed[dimension] + ledger.reserved[dimension];
}

function availableBudget(session: RuntimeSession, dimension: keyof BudgetAmounts): number {
  return Math.max(0, session.durable.state.budget.limits[dimension] - usedBudget(session, dimension));
}

function budgetFailure(message: string): BudgetFailure {
  return {
    kind: "recoverable_failure",
    code: "budget_exhausted",
    message,
    decisionAuthority: "resource_boundary"
  };
}

function hardBudgetFailure(session: RuntimeSession, action: ConvergenceAction): BudgetFailure | null {
  if (action.kind === "tool") {
    const available = availableBudget(session, "toolCalls");
    return action.count > available
      ? budgetFailure(`The next tool batch requires ${action.count} calls but only ${available} tool-call budget remains.`)
      : null;
  }
  const dimensions: Array<keyof BudgetAmounts> = ["inputTokens", "outputTokens", "modelTurns"];
  const exhausted = dimensions.find((dimension) => availableBudget(session, dimension) < 1);
  return exhausted
    ? budgetFailure(`No ${exhausted} budget remains for another model turn.`)
    : null;
}

/** Admit against explicit resource policy and, when configured, its deadline. */
export function convergenceAdmissionFailure(
  session: RuntimeSession,
  action: ConvergenceAction,
  now = Date.now()
): BudgetFailure | null {
  const hardFailure = hardBudgetFailure(session, action);
  if (hardFailure) return hardFailure;
  const forecast = deadlineForecast(session, now);
  if (forecast.stage === "stop") {
    return budgetFailure(
      `The absolute run deadline has elapsed; no further ${action.kind} action can be admitted.`
    );
  }
  if (forecast.stage === "converge"
    && action.kind === "tool"
    && action.terminalOnly !== true) {
    return budgetFailure(
      `Only ${Math.max(0, Math.floor(forecast.remainingMs ?? 0))}ms of active time remains, `
        + "which is reserved for a text-only final response and durable settlement; "
        + "no further non-terminal tool action can be admitted."
    );
  }
  return null;
}
