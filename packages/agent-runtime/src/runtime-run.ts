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

export async function runRuntimeSession(options: RuntimeRunOptions, session: RuntimeSession): Promise<void> {
  const controller = new AbortController();
  session.execution.controller = controller;
  const remainingMs = Date.parse(session.durable.state.deadlineAt) - Date.now();
  if (remainingMs <= 0) {
    await options.finish(session, {
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
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Run cancelled.");
      const outcome: RunOutcome = reason.name === "TimeoutError"
        ? { kind: "recoverable_failure", code: "budget_exhausted", message: reason.message }
        : { kind: "cancelled", reason: reason.message };
      await options.finish(session, outcome);
    } else {
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code : "runtime_error";
      await options.finish(session, {
        kind: "recoverable_failure",
        code,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  } finally {
    if (session.execution.deadlineTimer) clearTimeout(session.execution.deadlineTimer);
    session.execution.deadlineTimer = null;
    session.execution.controller = null;
  }
}
