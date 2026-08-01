import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export type ConvergenceAction =
  | { kind: "model" }
  | { kind: "tool"; count: number };

export type DeadlineStage = "unbounded" | "normal" | "stop";

export interface DeadlineForecast {
  stage: DeadlineStage;
  remainingMs?: number;
}

type BudgetFailure = Extract<RunOutcome, { kind: "recoverable_failure" }>;

export function deadlineForecast(session: RuntimeSession, now = Date.now()): DeadlineForecast {
  const paused = session.durable.state.deadlineRemainingMs;
  if (paused !== undefined) {
    return { stage: paused <= 0 ? "stop" : "normal", remainingMs: paused };
  }
  const deadlineAt = session.durable.state.deadlineAt;
  if (deadlineAt === undefined) return { stage: "unbounded" };
  const remainingMs = Date.parse(deadlineAt) - now;
  return { stage: remainingMs <= 0 ? "stop" : "normal", remainingMs };
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
  return null;
}
