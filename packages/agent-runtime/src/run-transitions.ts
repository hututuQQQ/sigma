import { randomUUID } from "node:crypto";
import { createKernelState } from "agent-kernel";
import type { AgentEventPayloadMap } from "agent-protocol";
import { sessionAssurancePolicy } from "./assurance-policy.js";
import { configuredRunDeadlineAt } from "./run-deadline.js";
import type { RuntimeSession } from "./types.js";
import type { FrozenHarnessBuild } from "./harness-compiler.js";

export function beginNextRun(
  session: RuntimeSession,
  mode: RuntimeSession["durable"]["mode"],
  runDeadlineMs?: number,
  harness?: FrozenHarnessBuild
): void {
  const effectiveMode = session.durable.legacyHarnessReadOnly ? "analyze" : mode;
  const effectiveHarness = harness ?? session.durable.frozenHarness;
  const now = new Date().toISOString();
  session.durable.runId = randomUUID();
  session.durable.modelTurn = 0;
  session.durable.mode = effectiveMode;
  if (effectiveHarness) session.durable.frozenHarness = effectiveHarness;
  const state = createKernelState({
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    mode: effectiveMode,
    startedAt: now,
    deadlineAt: configuredRunDeadlineAt(runDeadlineMs),
    assurancePolicy: sessionAssurancePolicy(session),
    harnessRequired: session.durable.state.harnessRequired
  });
  session.durable.state = {
    ...state,
    messages: session.durable.state.messages,
    lastSeq: session.durable.seq,
    plan: session.durable.state.plan,
    budget: session.durable.state.budget,
    frozenProfile: session.durable.state.frozenProfile,
    frozenCustomization: session.durable.state.frozenCustomization,
    harnessRequired: session.durable.state.harnessRequired,
    frozenHarness: harness
      ? { artifactId: harness.digest, digest: harness.digest }
      : session.durable.state.frozenHarness,
    loadedToolBundles: session.durable.state.loadedToolBundles,
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
    actualEffects: [],
    artifacts: [],
    diagnostics: ["recovery_retry_denied"],
    evidence: [],
    startedAt: now,
    completedAt: now,
    ...modelTurn
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
    actualEffects: [],
    artifacts: [],
    diagnostics: ["recovery_result_lost_no_replay"],
    evidence: [],
    startedAt: now,
    completedAt: now,
    ...modelTurn
  };
}
