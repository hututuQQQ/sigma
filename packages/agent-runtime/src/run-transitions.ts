import { randomUUID } from "node:crypto";
import { createKernelState } from "agent-kernel";
import type { AgentEventPayloadMap } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export function beginNextRun(
  session: RuntimeSession,
  mode: RuntimeSession["durable"]["mode"],
  runDeadlineMs: number
): void {
  const now = new Date().toISOString();
  session.durable.runId = randomUUID();
  session.durable.modelTurn = 0;
  session.durable.mode = mode;
  const state = createKernelState({
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    mode,
    startedAt: now,
    deadlineAt: new Date(Date.now() + runDeadlineMs).toISOString()
  });
  session.durable.state = {
    ...state,
    messages: session.durable.state.messages,
    lastSeq: session.durable.seq,
    plan: session.durable.state.plan,
    budget: session.durable.state.budget,
    frozenProfile: session.durable.state.frozenProfile,
    frozenCustomization: session.durable.state.frozenCustomization,
    frozenSkills: session.durable.state.frozenSkills,
    activeProcessIds: session.durable.state.activeProcessIds,
    // A completed run has already accepted this frontier as the new baseline;
    // a paused/recoverable run still owns its unresolved frontier. Neither may
    // be reconstructed from the session's full historical evidence list.
    mutationFrontier: session.durable.state.mutationFrontier,
    mutationEvidence: session.durable.state.mutationEvidence,
    // Evidence and waivers are run-scoped. Durable history remains in the
    // event log, but a follow-up must earn fresh evidence.
    evidence: [],
    usage: session.durable.state.usage
  };
  session.recovery.lastOutcome = undefined;
}

export function recoveryDenialPayload(
  callId: string,
  modelTurn: { turnId: number; effectRevision: number }
): AgentEventPayloadMap["tool.failed"] {
  const now = new Date().toISOString();
  return {
    callId,
    name: "tool",
    ok: false,
    output: "Interrupted tool retry denied by user.",
    outcome: {
      status: "failed",
      output: "Interrupted tool retry denied by user.",
      diagnosticCodes: ["recovery_retry_denied"]
    },
    observedEffects: [],
    artifacts: [],
    diagnostics: ["recovery_retry_denied"],
    startedAt: now,
    completedAt: now,
    turnId: modelTurn.turnId,
    effectRevision: modelTurn.effectRevision
  };
}

export function recoveryResultLostPayload(
  callId: string,
  modelTurn: { turnId: number; effectRevision: number }
): AgentEventPayloadMap["tool.failed"] {
  const now = new Date().toISOString();
  return {
    callId,
    name: "tool",
    ok: false,
    output: "The runtime stopped after this non-replayable tool began. Its result was lost, and the tool was not executed again.",
    outcome: {
      status: "failed",
      output: "The runtime stopped after this non-replayable tool began. Its result was lost, and the tool was not executed again.",
      diagnosticCodes: ["recovery_result_lost_no_replay"]
    },
    observedEffects: [],
    artifacts: [],
    diagnostics: ["recovery_result_lost_no_replay"],
    startedAt: now,
    completedAt: now,
    turnId: modelTurn.turnId,
    effectRevision: modelTurn.effectRevision
  };
}
