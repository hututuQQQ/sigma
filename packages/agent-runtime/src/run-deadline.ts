import type { RuntimeSession } from "./types.js";

function timeoutError(deadlineAt: string): Error {
  const error = new Error(`Run exceeded its durable active-time deadline ${deadlineAt}.`);
  error.name = "TimeoutError";
  return error;
}

export function pauseRunDeadline(session: RuntimeSession): number {
  const remaining = session.state.deadlineRemainingMs
    ?? Math.max(1, Date.parse(session.state.deadlineAt) - Date.now());
  if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
  session.deadlineTimer = null;
  return remaining;
}

export function resumedDeadlineAt(session: RuntimeSession): string | undefined {
  const remaining = session.state.deadlineRemainingMs;
  return remaining === undefined ? undefined : new Date(Date.now() + remaining).toISOString();
}

export function armRunDeadline(session: RuntimeSession): void {
  if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
  session.deadlineTimer = null;
  const controller = session.controller;
  if (!controller || session.state.deadlineRemainingMs !== undefined) return;
  const remaining = Date.parse(session.state.deadlineAt) - Date.now();
  if (remaining <= 0) {
    controller.abort(timeoutError(session.state.deadlineAt));
    return;
  }
  session.deadlineTimer = setTimeout(() => {
    controller.abort(timeoutError(session.state.deadlineAt));
  }, remaining);
}
