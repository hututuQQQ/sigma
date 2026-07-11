import type { RunOutcome } from "agent-protocol";
import { beginNextRun } from "./run-transitions.js";
import type { SessionCommandBus } from "./session-command-bus.js";
import { settleIdleWaiters } from "./runtime-waiters.js";
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
    if (session.running) return;
    session.runError = undefined;
    const task = this.drain(session);
    session.running = task;
    void task.then(
      async () => await this.settle(session, task),
      async (error) => await this.settle(session, task, error)
    ).catch(() => undefined);
  }

  private async drain(session: RuntimeSession): Promise<void> {
    while (true) {
      await this.options.run(session);
      const next = session.followUps.shift();
      if (!next) return;
      try {
        await this.options.commandBus.claim(session.sessionId);
        beginNextRun(session, session.mode, this.options.runDeadlineMs);
        await this.options.emit(session, "run.started", "runtime", {
          mode: session.mode, deadlineAt: session.state.deadlineAt
        });
        await this.options.emit(session, "user.follow_up", "user", {
          text: next.text, queueId: next.id, status: "delivered"
        });
      } catch (error) {
        if (session.state.phase === "terminal") {
          beginNextRun(session, session.mode, this.options.runDeadlineMs);
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
    await this.options.waitForQuiescence(session.sessionId).catch(() => undefined);
    if (session.running !== task) return;
    session.running = null;
    settleIdleWaiters(session, error);
  }
}
