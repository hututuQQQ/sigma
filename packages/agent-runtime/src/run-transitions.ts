import { randomUUID } from "node:crypto";
import { createKernelState } from "agent-kernel";
import type { RuntimeSession } from "./types.js";

export function beginNextRun(session: RuntimeSession, mode: RuntimeSession["mode"], runDeadlineMs: number): void {
  const now = new Date().toISOString();
  session.runId = randomUUID();
  session.modelTurn = 0;
  session.mode = mode;
  const state = createKernelState({
    sessionId: session.sessionId,
    runId: session.runId,
    mode,
    startedAt: now,
    deadlineAt: new Date(Date.now() + runDeadlineMs).toISOString()
  });
  session.state = { ...state, messages: session.state.messages, lastSeq: session.seq };
  session.lastOutcome = undefined;
}

export function recoveryDenialPayload(
  callId: string,
  modelTurn: { turnId: number; effectRevision: number }
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    callId,
    name: "tool",
    ok: false,
    output: "Interrupted tool retry denied by user.",
    observedEffects: [],
    artifacts: [],
    diagnostics: ["recovery_retry_denied"],
    startedAt: now,
    completedAt: now,
    ...modelTurn
  };
}
