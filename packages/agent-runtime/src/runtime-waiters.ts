import type { RunOutcome } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export async function waitForSessionOutcome(session: RuntimeSession, signal?: AbortSignal): Promise<RunOutcome> {
  if (session.recovery.lastOutcome && (session.durable.state.phase === "terminal" || (session.durable.state.phase === "needs_input" && !session.execution.running))) {
    return session.recovery.lastOutcome;
  }
  return await new Promise<RunOutcome>((resolve, reject) => {
    const waiter = { runId: session.durable.runId, resolve };
    const onAbort = (): void => {
      signal?.removeEventListener("abort", onAbort);
      const index = session.interaction.outcomeWaiters.indexOf(waiter);
      if (index >= 0) session.interaction.outcomeWaiters.splice(index, 1);
      reject(signal?.reason ?? new Error("Outcome wait cancelled."));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiter.resolve = (outcome) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    session.interaction.outcomeWaiters.push(waiter);
  });
}

export async function waitForSessionIdleOutcome(
  session: RuntimeSession,
  waitForQuiescence: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal
): Promise<RunOutcome> {
  while (true) {
    while (session.execution.running || session.interaction.followUps.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject };
        const onAbort = (): void => {
          signal?.removeEventListener("abort", onAbort);
          const index = session.interaction.idleWaiters.indexOf(waiter);
          if (index >= 0) session.interaction.idleWaiters.splice(index, 1);
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
        session.interaction.idleWaiters.push(waiter);
      });
    }
    if (session.recovery.runError) throw session.recovery.runError;
    await waitForQuiescence(signal);
    if (!session.execution.running && session.interaction.followUps.length === 0) break;
  }
  const outcome = session.recovery.lastOutcome ?? session.durable.state.outcome;
  if (!outcome) throw new Error(`Session '${session.identity.sessionId}' became idle without an outcome.`);
  return outcome;
}

export function resolveOutcomeWaiters(session: RuntimeSession, runId: string, outcome: RunOutcome): void {
  const matching = session.interaction.outcomeWaiters.filter((waiter) => waiter.runId === runId);
  session.interaction.outcomeWaiters = session.interaction.outcomeWaiters.filter((waiter) => waiter.runId !== runId);
  for (const waiter of matching) waiter.resolve(outcome);
}

export function settleIdleWaiters(session: RuntimeSession, error?: unknown): void {
  session.recovery.runError = error instanceof Error ? error : error === undefined ? undefined : new Error(String(error));
  for (const waiter of session.interaction.idleWaiters.splice(0)) {
    if (session.recovery.runError) waiter.reject(session.recovery.runError);
    else waiter.resolve();
  }
}
