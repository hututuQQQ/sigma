import type { BudgetAmounts, RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

const ACTION_SETTLEMENT_GRACE_MS = 500;
const MODEL_MINIMUM_MS = 500;
const MODEL_MAXIMUM_MS = 60_000;
const TOOL_MINIMUM_MS = 250;
const TOOL_MAXIMUM_MS = 30_000;

export type ConvergenceAction =
  | { kind: "model" }
  | { kind: "tool"; count: number; terminalOnly?: boolean };

function quantile(values: readonly number[], fraction: number, fallback: number): number {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (finite.length === 0) return fallback;
  return finite[Math.min(finite.length - 1, Math.floor((finite.length - 1) * fraction))]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function modelEstimateMs(session: RuntimeSession): number {
  const samples = session.durable.state.usage
    .filter((item) => item.runId === session.durable.runId && item.role === session.services.modelRole)
    .slice(-8)
    .map((item) => item.latencyMs);
  return clamp(Math.ceil(quantile(samples, 0.75, MODEL_MINIMUM_MS) * 1.5), MODEL_MINIMUM_MS, MODEL_MAXIMUM_MS);
}

function toolEstimateMs(session: RuntimeSession, terminalOnly: boolean): number {
  if (terminalOnly) return TOOL_MINIMUM_MS;
  const samples = session.durable.state.receipts.slice(-12).flatMap((receipt) => {
    const started = Date.parse(receipt.startedAt);
    const completed = Date.parse(receipt.completedAt);
    return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
      ? [completed - started] : [];
  });
  return clamp(Math.ceil(quantile(samples, 0.75, 500) * 1.5), TOOL_MINIMUM_MS, TOOL_MAXIMUM_MS);
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
 * Admit a model/tool action against the same durable budget and active-time
 * view. Hard reservations still perform exact accounting; this forecast only
 * prevents beginning work that cannot reasonably settle before the outer
 * deadline, so the run can commit a normal typed failure instead of crashing
 * in the deadline race.
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
  const estimateMs = action.kind === "model"
    ? modelEstimateMs(session)
    : toolEstimateMs(session, action.terminalOnly === true);
  const requiredMs = estimateMs + ACTION_SETTLEMENT_GRACE_MS;
  if (remainingMs > requiredMs) return null;
  return budgetFailure(
    `Only ${Math.max(0, Math.floor(remainingMs))}ms of active time remains; the next ${action.kind} action and durable settlement require approximately ${requiredMs}ms. Stopped before the hard deadline.`
  );
}
