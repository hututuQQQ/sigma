import type { RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export async function waitForSessionOutcome(session: RuntimeSession, signal?: AbortSignal): Promise<RunOutcome> {
  if (session.lastOutcome && (session.state.phase === "terminal" || (session.state.phase === "needs_input" && !session.running))) {
    return session.lastOutcome;
  }
  return await new Promise<RunOutcome>((resolve, reject) => {
    const waiter = { runId: session.runId, resolve };
    const onAbort = (): void => {
      signal?.removeEventListener("abort", onAbort);
      const index = session.outcomeWaiters.indexOf(waiter);
      if (index >= 0) session.outcomeWaiters.splice(index, 1);
      reject(signal?.reason ?? new Error("Outcome wait cancelled."));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiter.resolve = (outcome) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    session.outcomeWaiters.push(waiter);
  });
}

export async function waitForSessionIdleOutcome(
  session: RuntimeSession,
  waitForQuiescence: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal
): Promise<RunOutcome> {
  while (true) {
    while (session.running || session.followUps.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject };
        const onAbort = (): void => {
          signal?.removeEventListener("abort", onAbort);
          const index = session.idleWaiters.indexOf(waiter);
          if (index >= 0) session.idleWaiters.splice(index, 1);
          reject(signal?.reason ?? new Error("Idle wait cancelled."));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        waiter.resolve = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        waiter.reject = (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        };
        session.idleWaiters.push(waiter);
      });
    }
    if (session.runError) throw session.runError;
    await waitForQuiescence(signal);
    if (!session.running && session.followUps.length === 0) break;
  }
  const outcome = session.lastOutcome ?? session.state.outcome;
  if (!outcome) throw new Error(`Session '${session.sessionId}' became idle without an outcome.`);
  return outcome;
}

export function resolveOutcomeWaiters(session: RuntimeSession, runId: string, outcome: RunOutcome): void {
  const matching = session.outcomeWaiters.filter((waiter) => waiter.runId === runId);
  session.outcomeWaiters = session.outcomeWaiters.filter((waiter) => waiter.runId !== runId);
  for (const waiter of matching) waiter.resolve(outcome);
}

export function settleIdleWaiters(session: RuntimeSession, error?: unknown): void {
  session.runError = error instanceof Error ? error : error === undefined ? undefined : new Error(String(error));
  for (const waiter of session.idleWaiters.splice(0)) {
    if (session.runError) waiter.reject(session.runError);
    else waiter.resolve();
  }
}
