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
  session.controller = controller;
  const remainingMs = Date.parse(session.state.deadlineAt) - Date.now();
  if (remainingMs <= 0) {
    await options.finish(session, {
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: `Run deadline ${session.state.deadlineAt} has already elapsed.`
    });
    session.controller = null;
    return;
  }
  armRunDeadline(session);
  try {
    await options.hooks.dispatch(session, "run_start", {
      sessionId: session.sessionId,
      runId: session.runId,
      mode: session.mode,
      deadlineAt: session.state.deadlineAt
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
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadlineTimer = null;
    session.controller = null;
  }
}
