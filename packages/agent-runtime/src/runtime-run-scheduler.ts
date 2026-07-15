import type { RunOutcome } from "agent-protocol";
import { beginNextRun } from "./run-transitions.js";
import type { SessionCommandBus } from "./session-command-bus.js";
import { rejectOutcomeWaiters, settleIdleWaiters } from "./runtime-waiters.js";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

export interface RuntimeRunSchedulerOptions {
  runDeadlineMs: number;
  commandBus: SessionCommandBus;
  run(session: RuntimeSession): Promise<void>;
  emit: RuntimeEventEmitter;
  finish(session: RuntimeSession, outcome: RunOutcome): Promise<boolean>;
  waitForQuiescence(sessionId: string): Promise<void>;
}

export class RuntimeRunScheduler {
  constructor(private readonly options: RuntimeRunSchedulerOptions) {}

  start(session: RuntimeSession): void {
    if (session.execution.running) return;
    session.recovery.runError = undefined;
    const task = this.drain(session);
    session.execution.running = task;
    void task.then(
      async () => await this.settle(session, task),
      async (error) => await this.settle(session, task, error)
    ).catch(() => undefined);
  }

  private async drain(session: RuntimeSession): Promise<void> {
    while (true) {
      await this.options.run(session);
      const next = session.interaction.followUps.shift();
      if (!next) return;
      try {
        await this.options.commandBus.claim(session.identity.sessionId);
        beginNextRun(session, session.durable.mode, this.options.runDeadlineMs);
        await this.options.emit(session, "run.started", "runtime", {
          mode: session.durable.mode, deadlineAt: session.durable.state.deadlineAt
        });
        await this.options.emit(session, "user.follow_up", "user", {
          text: next.text, queueId: next.id, status: "delivered"
        });
      } catch (error) {
        if (session.durable.state.phase === "terminal") {
          beginNextRun(session, session.durable.mode, this.options.runDeadlineMs);
        }
        await this.options.finish(session, {
          kind: "recoverable_failure",
          code: "follow_up_handoff_failed",
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    }
  }

  private async settle(session: RuntimeSession, task: Promise<void>, error?: unknown): Promise<void> {
    await this.options.waitForQuiescence(session.identity.sessionId).catch(() => undefined);
    if (session.execution.running !== task) return;
    session.execution.running = null;
    if (error !== undefined) rejectOutcomeWaiters(session, session.durable.runId, error);
    settleIdleWaiters(session, error);
  }
}
