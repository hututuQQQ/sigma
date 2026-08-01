import type { RuntimeSession } from "./types.js";

export function configuredRunDeadlineAt(runDeadlineMs?: number): string | undefined {
  if (runDeadlineMs === undefined) return undefined;
  if (!Number.isSafeInteger(runDeadlineMs) || runDeadlineMs <= 0) {
    throw new RangeError("runDeadlineMs must be a positive integer when configured.");
  }
  return new Date(Date.now() + runDeadlineMs).toISOString();
}

function timeoutError(deadlineAt: string): Error {
  const error = Object.assign(
    new Error(`Run exceeded its durable active-time deadline ${deadlineAt}.`),
    { code: "run_deadline" }
  );
  error.name = "TimeoutError";
  return error;
}

export function pauseRunDeadline(session: RuntimeSession): number | undefined {
  if (!session.durable.state.deadlineAt) return undefined;
  const remaining = session.durable.state.deadlineRemainingMs
    ?? Math.max(1, Date.parse(session.durable.state.deadlineAt) - Date.now());
  if (session.execution.deadlineTimer) clearTimeout(session.execution.deadlineTimer);
  session.execution.deadlineTimer = null;
  return remaining;
}

export function resumedDeadlineAt(session: RuntimeSession): string | undefined {
  const remaining = session.durable.state.deadlineRemainingMs;
  return remaining === undefined ? undefined : new Date(Date.now() + remaining).toISOString();
}

export function armRunDeadline(session: RuntimeSession): void {
  if (session.execution.deadlineTimer) clearTimeout(session.execution.deadlineTimer);
  session.execution.deadlineTimer = null;
  const controller = session.execution.controller;
  const deadlineAt = session.durable.state.deadlineAt;
  if (!controller || !deadlineAt || session.durable.state.deadlineRemainingMs !== undefined) return;
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (remaining <= 0) {
    controller.abort(timeoutError(deadlineAt));
    return;
  }
  session.execution.deadlineTimer = setTimeout(() => {
    controller.abort(timeoutError(deadlineAt));
  }, remaining);
}
