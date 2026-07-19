import type { AgentEventEnvelope, RunOutcome } from "agent-protocol";
import { resolveOutcomeWaiters } from "./runtime-waiters.js";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventLog } from "./runtime-event-log.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import type { SessionCommandBus } from "./session-command-bus.js";
import {
  completionCoordinatorState,
  completionLimitations,
  currentRunEvidence
} from "./completion-evidence-gate.js";
import { refreshValidationCapabilityProfile } from "./validation-capability-profile.js";

export type RunSuspensionContext =
  | { processIds: string[] }
  | { checkpointId: string; choices: ["restore", "keep"] }
  | { remainingDeadlineMs: number };

export interface RuntimeSessionFinishOptions {
  hooks: RuntimeHookCoordinator;
  events: RuntimeEventLog;
  commandBus: SessionCommandBus;
  cancelChildren?(parentSessionId: string, reason: string): Promise<void> | void;
  beforeOutcome?(session: RuntimeSession, outcome: RunOutcome): Promise<number>;
}

function isCurrentOutcomeRevision(session: RuntimeSession, outcomeRevision?: number): boolean {
  return outcomeRevision === undefined
    || (session.durable.state.phase === "outcome_pending" && session.durable.state.revision === outcomeRevision);
}

function failureFromHook(error: unknown): RunOutcome {
  return {
    kind: "recoverable_failure",
    code: typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "hook_failed",
    message: error instanceof Error ? error.message : String(error)
  };
}

async function applyFinishHooks(
  hooks: RuntimeHookCoordinator,
  session: RuntimeSession,
  outcome: RunOutcome
): Promise<RunOutcome> {
  try {
    if (outcome.kind === "completed" || outcome.kind === "completed_with_limitations") {
      await hooks.dispatch(session, "pre_complete", {
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        outcome
      }, new AbortController().signal);
    }
    await hooks.dispatch(session, "run_end", {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      outcome
    }, new AbortController().signal);
    return outcome;
  } catch (error) {
    return failureFromHook(error);
  }
}

function outcomeEventType(
  outcome: RunOutcome
): "run.completed" | "run.cancelled" | "run.suspended" | "run.failed" {
  if (outcome.kind === "completed" || outcome.kind === "completed_with_limitations") return "run.completed";
  if (outcome.kind === "cancelled") return "run.cancelled";
  if (outcome.kind === "needs_input") return "run.suspended";
  return "run.failed";
}

async function emitOutcome(
  options: RuntimeSessionFinishOptions,
  session: RuntimeSession,
  outcome: RunOutcome,
  outcomeRevision?: number,
  suspensionContext?: RunSuspensionContext
): Promise<AgentEventEnvelope | undefined> {
  const type = outcomeEventType(outcome);
  const reviewed = completionCoordinatorState(session).reviewSatisfied;
  const payload = outcome.kind === "completed"
    ? { ...outcome, coordinator: {
        modelStopped: true as const,
        assuranceSatisfied: true as const,
        reviewSatisfied: reviewed,
        runCompleted: true as const
      } }
    : outcome.kind === "completed_with_limitations"
      ? { ...outcome, coordinator: {
          modelStopped: true as const,
          assuranceSatisfied: false as const,
          reviewSatisfied: reviewed,
          limitationsAccepted: true as const,
          runCompleted: true as const
        } }
    : outcome.kind === "needs_input" && suspensionContext
      ? { ...outcome, ...suspensionContext }
      : outcome;
  if (outcomeRevision === undefined) {
    return await options.events.emit(session, type, "runtime", payload);
  }
  return await options.events.emitOutcomeIfCurrent(session, type, payload, session.durable.state.revision);
}

function outcomeWasCommitted(session: RuntimeSession, outcome: RunOutcome): boolean {
  return outcome.kind === "needs_input"
    ? session.durable.state.phase === "needs_input"
    : session.durable.state.phase === "terminal";
}

async function cancelChildrenAfterFailure(
  options: RuntimeSessionFinishOptions,
  session: RuntimeSession,
  outcome: RunOutcome
): Promise<void> {
  if (outcome.kind === "completed" || outcome.kind === "completed_with_limitations") return;
  await options.cancelChildren?.(session.identity.sessionId, `Parent run ended as ${outcome.kind}.`);
}

async function completionCoordinatedOutcome(
  session: RuntimeSession,
  outcome: RunOutcome
): Promise<RunOutcome> {
  if (outcome.kind !== "completed" && outcome.kind !== "completed_with_limitations") return outcome;
  // Recovery may arrive directly at outcome_pending without another model
  // turn. Re-derive the non-durable capability profile before applying the
  // same completion gates used during a live run.
  await refreshValidationCapabilityProfile(session, new AbortController().signal);
  const coordinator = completionCoordinatorState(session);
  if (coordinator.actualValidationFailed) {
    return {
      kind: "recoverable_failure",
      code: "validation_failed",
      message: "Model stopped, but a current-frontier required validation has an actual failure. Repair and validate again before completion."
    };
  }
  if (coordinator.runCompleted) return {
    ...outcome,
    evidence: coordinatedCompletionEvidence(session, outcome)
  };
  const limitations = completionLimitations(session);
  if (limitations) {
    const combined = [
      ...(outcome.kind === "completed_with_limitations" ? outcome.limitations : []),
      ...limitations
    ];
    const limited: RunOutcome = {
      kind: "completed_with_limitations",
      message: outcome.message,
      evidence: [],
      limitations: combined
    };
    return { ...limited, evidence: coordinatedCompletionEvidence(session, limited) };
  }
  return {
    kind: "recoverable_failure",
    code: "completion_coordinator_rejected",
    message: `Model stopped, but completion gates remain unsatisfied (assurance=${coordinator.assuranceSatisfied}, review=${coordinator.reviewSatisfied}).`
  };
}

function coordinatedCompletionEvidence(session: RuntimeSession, outcome: RunOutcome) {
  const ordinary = currentRunEvidence(session);
  if (outcome.kind !== "completed_with_limitations") return ordinary;
  const limitationIds = new Set(outcome.limitations.map((item) => item.capabilityEvidenceId));
  const capability = session.durable.state.evidence.filter((item) =>
    limitationIds.has(item.evidenceId)
    && item.kind === "validation"
    && item.status === "failed"
    && item.data.claim?.status === "unavailable");
  return [...new Map([...ordinary, ...capability].map((item) => [item.evidenceId, item])).values()];
}

export async function finishRuntimeSession(
  options: RuntimeSessionFinishOptions,
  session: RuntimeSession,
  outcome: RunOutcome,
  outcomeRevision?: number,
  suspensionContext?: RunSuspensionContext
): Promise<boolean> {
  if (!isCurrentOutcomeRevision(session, outcomeRevision)) return false;
  const coordinatedOutcome = await completionCoordinatedOutcome(session, outcome);
  const finalOutcome = await applyFinishHooks(options.hooks, session, coordinatedOutcome);
  if (outcomeRevision !== undefined && session.durable.state.phase !== "outcome_pending") return false;
  await options.beforeOutcome?.(session, finalOutcome);
  if (outcomeRevision !== undefined && session.durable.state.phase !== "outcome_pending") return false;
  const commitRevision = outcomeRevision === undefined ? undefined : session.durable.state.revision;
  const event = await emitOutcome(options, session, finalOutcome, commitRevision, suspensionContext);
  if (!event || session.durable.state.lastSeq !== event.seq || !outcomeWasCommitted(session, finalOutcome)) return false;
  await cancelChildrenAfterFailure(options, session, finalOutcome);
  session.recovery.lastOutcome = finalOutcome;
  await options.events.writeSnapshot(session);
  if (session.interaction.followUps.length === 0) await options.commandBus.release(session.identity.sessionId);
  resolveOutcomeWaiters(session, event.runId, finalOutcome);
  return true;
}
