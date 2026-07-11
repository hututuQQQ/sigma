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
  session.state = {
    ...state,
    messages: session.state.messages,
    lastSeq: session.seq,
    plan: session.state.plan,
    budget: session.state.budget,
    frozenProfile: session.state.frozenProfile,
    frozenCustomization: session.state.frozenCustomization,
    frozenSkills: session.state.frozenSkills,
    activeProcessIds: session.state.activeProcessIds,
    mutationEvidence: session.state.mutationEvidence,
    // Evidence and waivers are run-scoped. Durable history remains in the
    // event log, but a follow-up must earn fresh evidence.
    evidence: [],
    usage: session.state.usage
  };
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

export function recoveryResultLostPayload(
  callId: string,
  modelTurn: { turnId: number; effectRevision: number }
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    callId,
    name: "tool",
    ok: false,
    output: "The runtime stopped after this non-replayable tool began. Its result was lost, and the tool was not executed again.",
    observedEffects: [],
    artifacts: [],
    diagnostics: ["recovery_result_lost_no_replay"],
    startedAt: now,
    completedAt: now,
    ...modelTurn
  };
}
