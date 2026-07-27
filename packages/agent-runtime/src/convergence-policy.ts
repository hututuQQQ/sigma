import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export const ACTION_SETTLEMENT_GRACE_MS = 10_000;

export type ConvergenceAction =
  | { kind: "model" }
  | { kind: "tool"; count: number; terminalOnly?: boolean };

export type DeadlineStage = "normal" | "converge" | "stop";

export interface DeadlineForecast {
  stage: DeadlineStage;
  remainingMs: number;
  usableMs: number;
  settlementReserveMs: number;
}

export interface ConvergenceActionScope {
  signal: AbortSignal;
  forecast: DeadlineForecast;
  close(): void;
}

type BudgetFailure = Extract<RunOutcome, { kind: "recoverable_failure" }>;

export function deadlineForecast(session: RuntimeSession, now = Date.now()): DeadlineForecast {
  const remainingMs = session.durable.state.deadlineRemainingMs
    ?? Date.parse(session.durable.state.deadlineAt) - now;
  const usableMs = Math.max(0, remainingMs - ACTION_SETTLEMENT_GRACE_MS);
  const stage: DeadlineStage = remainingMs <= 0
    ? "stop"
    : usableMs <= 0 ? "converge" : "normal";
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

function budgetFailure(message: string): BudgetFailure {
  return {
    kind: "recoverable_failure",
    code: "budget_exhausted",
    message,
    decisionAuthority: "resource_boundary"
  };
}

function convergenceBoundaryError(action: ConvergenceAction, forecast: DeadlineForecast): Error {
  const error = Object.assign(new Error(
    `The active ${action.kind} action reached the durable settlement boundary; `
      + `${forecast.settlementReserveMs}ms remains reserved for convergence.`
  ), {
    code: "budget_exhausted",
    decisionAuthority: "resource_boundary"
  });
  error.name = "ResourceBoundaryError";
  return error;
}

/**
 * Bound already-admitted non-terminal work to the same convergence boundary
 * used for admission. The outer run signal remains live during the settlement
 * reserve so interrupted work can commit its ledger and hand off cleanly.
 */
export function openConvergenceActionScope(
  session: RuntimeSession,
  parent: AbortSignal,
  action: ConvergenceAction,
  now = Date.now()
): ConvergenceActionScope {
  const forecast = deadlineForecast(session, now);
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(parent.reason ?? new Error("Runtime action aborted."));
  };
  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = forecast.usableMs > 0
    ? setTimeout(
        () => controller.abort(convergenceBoundaryError(action, forecast)),
        Math.min(2_147_483_647, Math.max(1, Math.floor(forecast.usableMs)))
      )
    : undefined;
  if (forecast.usableMs <= 0 && !controller.signal.aborted) {
    controller.abort(convergenceBoundaryError(action, forecast));
  }
  return {
    signal: controller.signal,
    forecast,
    close: () => {
      if (timer) clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    }
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

/**
 * Admit only against facts the runtime can prove: the durable hard ledger and
 * the absolute deadline. The fixed settlement reserve is not a latency
 * forecast: it prevents starting non-terminal work after the runtime has
 * committed the remaining active time to durable settlement.
 */
export function convergenceAdmissionFailure(
  session: RuntimeSession,
  action: ConvergenceAction,
  now = Date.now()
): BudgetFailure | null {
  const hardFailure = hardBudgetFailure(session, action);
  if (hardFailure) return hardFailure;
  const forecast = deadlineForecast(session, now);
  if (forecast.remainingMs <= 0) {
    return budgetFailure(
      `The absolute run deadline has elapsed; no further ${action.kind} action can be admitted.`
    );
  }
  if (action.kind === "tool" && action.terminalOnly === true) return null;
  if (forecast.usableMs > 0) return null;
  return budgetFailure(
    `Only ${Math.max(0, Math.floor(forecast.remainingMs))}ms of active time remains, `
      + `which is reserved for durable settlement; no further non-terminal ${action.kind} action can be admitted.`
  );
}
