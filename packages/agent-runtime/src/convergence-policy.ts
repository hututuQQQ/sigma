import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export const ACTION_SETTLEMENT_GRACE_MS = 10_000;

export type ConvergenceAction =
  | { kind: "model" }
  | { kind: "tool"; count: number; terminalOnly?: boolean };

export type DeadlineStage = "normal" | "stop";

export interface DeadlineForecast {
  stage: DeadlineStage;
  remainingMs: number;
  usableMs: number;
  settlementReserveMs: number;
}

export function deadlineForecast(session: RuntimeSession, now = Date.now()): DeadlineForecast {
  const remainingMs = session.durable.state.deadlineRemainingMs
    ?? Date.parse(session.durable.state.deadlineAt) - now;
  const usableMs = Math.max(0, remainingMs - ACTION_SETTLEMENT_GRACE_MS);
  const stage: DeadlineStage = remainingMs <= 0 ? "stop" : "normal";
  return {
    stage,
    remainingMs,
    usableMs,
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
  return {
    kind: "recoverable_failure",
    code: "budget_exhausted",
    message,
    decisionAuthority: "resource_boundary"
  };
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
