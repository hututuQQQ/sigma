import type { RunOutcome } from "agent-protocol";
import type { EffectRunner } from "./effect-runner.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import type { RuntimeSession } from "./types.js";
import { armRunDeadline } from "./run-deadline.js";

export interface RuntimeRunOptions {
  hooks: RuntimeHookCoordinator;
  effects: EffectRunner;
  finish(session: RuntimeSession, outcome: RunOutcome): Promise<boolean>;
}

function hasRunOutcome(session: RuntimeSession): boolean {
  return Boolean(session.recovery.lastOutcome ?? session.durable.state.outcome);
}

function runtimeLifecycleError(session: RuntimeSession, message: string): Error {
  return Object.assign(new Error(
    `${message} session=${session.identity.sessionId}, run=${session.durable.runId}, phase=${session.durable.state.phase}, seq=${session.durable.seq}.`
  ), { code: "runtime_terminal_missing" });
}

async function finishOrThrow(
  options: RuntimeRunOptions,
  session: RuntimeSession,
  outcome: RunOutcome
): Promise<void> {
  const committed = await options.finish(session, outcome);
  if (!committed && !hasRunOutcome(session)) {
    throw runtimeLifecycleError(session, "Runtime could not commit a terminal outcome");
  }
}

function errorCode(error: unknown, fallback: string): string {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : fallback;
}

function isControllerInterruption(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return signal.reason instanceof Error && error.cause === signal.reason;
}

/** Preserve a concrete protocol/tool failure when it merely races with the
 * outer deadline. Only an error attributable to this controller is projected
 * as cancellation/deadline exhaustion. */
export function runtimeFailureOutcome(error: unknown, signal: AbortSignal): RunOutcome {
  if (!isControllerInterruption(error, signal)) {
    return {
      kind: "recoverable_failure",
      code: errorCode(error, "runtime_error"),
      message: error instanceof Error ? error.message : String(error)
    };
  }
  const reason = signal.reason instanceof Error ? signal.reason : new Error("Run cancelled.");
  return reason.name === "TimeoutError"
    ? { kind: "recoverable_failure", code: "budget_exhausted", message: reason.message }
    : { kind: "cancelled", reason: reason.message };
}

export async function runRuntimeSession(options: RuntimeRunOptions, session: RuntimeSession): Promise<void> {
  const controller = new AbortController();
  session.execution.controller = controller;
  const remainingMs = Date.parse(session.durable.state.deadlineAt) - Date.now();
  if (remainingMs <= 0) {
    await finishOrThrow(options, session, {
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: `Run deadline ${session.durable.state.deadlineAt} has already elapsed.`
    });
    session.execution.controller = null;
    return;
  }
  armRunDeadline(session);
  try {
    await options.hooks.dispatch(session, "run_start", {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      mode: session.durable.mode,
      deadlineAt: session.durable.state.deadlineAt
    }, controller.signal);
    await options.effects.run(session, controller.signal);
    if (!hasRunOutcome(session) && session.durable.state.phase !== "needs_input") {
      await finishOrThrow(options, session, {
        kind: "recoverable_failure",
        code: "runtime_terminal_missing",
        message: runtimeLifecycleError(
          session,
          "Runtime effect processing became idle without a terminal outcome"
        ).message
      });
    }
  } catch (error) {
    await finishOrThrow(options, session, runtimeFailureOutcome(error, controller.signal));
  } finally {
    if (session.execution.deadlineTimer) clearTimeout(session.execution.deadlineTimer);
    session.execution.deadlineTimer = null;
    session.execution.controller = null;
  }
}
