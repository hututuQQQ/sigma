import { describe, expect, it, vi } from "vitest";
import type { RunOutcome } from "../packages/agent-protocol/src/index.js";
import { finishRuntimeSession } from "../packages/agent-runtime/src/runtime-session-finish.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function finishFixture(options: {
  snapshotFailure?: Error;
  releaseFailure?: Error;
  childFailure?: Error;
} = {}) {
  const session = runtimeSessionFixture();
  const emitted: Array<{ type: string; payload: RunOutcome }> = [];
  const events = {
    emit: vi.fn(async (_session, type: string, _authority, payload: RunOutcome) => {
      const seq = session.durable.seq + 1;
      session.durable.seq = seq;
      session.durable.state.lastSeq = seq;
      session.durable.state.phase = type === "run.suspended" ? "needs_input" : "terminal";
      session.durable.state.outcome = payload;
      emitted.push({ type, payload });
      return { seq, runId: session.durable.runId };
    }),
    emitOutcomeIfCurrent: vi.fn(),
    writeSnapshot: vi.fn(async () => {
      if (options.snapshotFailure) throw options.snapshotFailure;
    })
  };
  const release = vi.fn(async () => {
    if (options.releaseFailure) throw options.releaseFailure;
  });
  const finishOptions = {
    hooks: { dispatch: vi.fn(async () => undefined) },
    events,
    commandBus: { release },
    beforeOutcome: vi.fn(async () => 0),
    cancelChildren: vi.fn(async () => {
      if (options.childFailure) throw options.childFailure;
    })
  } as unknown as Parameters<typeof finishRuntimeSession>[0];
  return { session, emitted, events, release, finishOptions };
}

describe("runtime terminal commit", () => {
  it("keeps the committed event authoritative when post-commit maintenance fails", async () => {
    const fixture = finishFixture({
      snapshotFailure: new Error("snapshot unavailable"),
      releaseFailure: new Error("lease release unavailable")
    });
    const resolve = vi.fn();
    fixture.session.interaction.outcomeWaiters.push({
      runId: fixture.session.durable.runId,
      resolve,
      reject: vi.fn()
    });
    const outcome = {
      kind: "needs_input" as const,
      requestId: "approval",
      message: "approval required"
    };

    await expect(finishRuntimeSession(
      fixture.finishOptions,
      fixture.session,
      outcome
    )).resolves.toBe(true);

    expect(fixture.emitted).toEqual([{ type: "run.suspended", payload: outcome }]);
    expect(fixture.session.recovery.lastOutcome).toEqual(outcome);
    expect(resolve).toHaveBeenCalledWith(outcome);
  });

  it("classifies child settlement failure before emitting a single terminal event", async () => {
    const fixture = finishFixture({ childFailure: new Error("child cleanup failed") });
    const resolve = vi.fn();
    fixture.session.interaction.outcomeWaiters.push({
      runId: fixture.session.durable.runId,
      resolve,
      reject: vi.fn()
    });

    await expect(finishRuntimeSession(fixture.finishOptions, fixture.session, {
      kind: "needs_input",
      requestId: "approval",
      message: "approval required"
    })).resolves.toBe(true);

    expect(fixture.emitted).toHaveLength(1);
    expect(fixture.emitted[0]).toMatchObject({
      type: "run.failed",
      payload: {
        kind: "recoverable_failure",
        code: "child_settlement_failed",
        message: "child cleanup failed"
      }
    });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      kind: "recoverable_failure",
      code: "child_settlement_failed"
    }));
  });
});
