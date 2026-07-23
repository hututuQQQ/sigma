import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export const ACTION_SETTLEMENT_GRACE_MS = 10_000;
const MODEL_MINIMUM_MS = 15_000;
const MODEL_MAXIMUM_MS = 180_000;

export type ConvergenceAction =
  | { kind: "model" }
  | { kind: "tool"; count: number; terminalOnly?: boolean };

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
    .filter((item) => item.runId === session.durable.runId)
    .slice(-8)
    .map((item) => item.latencyMs);
  return clamp(Math.ceil(quantile(samples, 0.90, MODEL_MINIMUM_MS / 1.5) * 1.5), MODEL_MINIMUM_MS, MODEL_MAXIMUM_MS);
}

export type DeadlineStage = "normal" | "converge" | "stop";

export interface DeadlineForecast {
  stage: DeadlineStage;
  remainingMs: number;
  usableMs: number;
  nextModelEstimateMs: number;
  settlementReserveMs: number;
}

export function deadlineForecast(session: RuntimeSession, now = Date.now()): DeadlineForecast {
  const remainingMs = session.durable.state.deadlineRemainingMs
    ?? Date.parse(session.durable.state.deadlineAt) - now;
  const nextModelEstimateMs = modelEstimateMs(session);
  const usableMs = Math.max(0, remainingMs - ACTION_SETTLEMENT_GRACE_MS);
  const stage: DeadlineStage = remainingMs <= 0 ? "stop" : "normal";
  return {
    stage,
    remainingMs,
    usableMs,
    nextModelEstimateMs,
    settlementReserveMs: ACTION_SETTLEMENT_GRACE_MS
  };
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
  const dimensions: Array<keyof BudgetAmounts> = ["inputTokens", "outputTokens", "modelTurns"];
  const exhausted = dimensions.find((dimension) => availableBudget(session, dimension) < 1);
  return exhausted
    ? budgetFailure(`No ${exhausted} budget remains for another model turn.`)
    : null;
}

/**
 * Admit only against facts the runtime can prove: the durable hard ledger and
 * the absolute deadline. Latency forecasts remain telemetry and never end a
 * run early or narrow the model's choices.
 */
export function convergenceAdmissionFailure(
  session: RuntimeSession,
  action: ConvergenceAction,
  now = Date.now()
): RunOutcome | null {
  const hardFailure = hardBudgetFailure(session, action);
  if (hardFailure) return hardFailure;
  const remainingMs = session.durable.state.deadlineRemainingMs
    ?? Date.parse(session.durable.state.deadlineAt) - now;
  if (remainingMs > 0) return null;
  return budgetFailure(
    `The absolute run deadline has elapsed; no further ${action.kind} action can be admitted.`
  );
}
