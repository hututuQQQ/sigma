import type { AgentEventEnvelope, RunOutcome } from "agent-protocol";
import { resolveOutcomeWaiters } from "./runtime-waiters.js";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventLog } from "./runtime-event-log.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import type { SessionCommandBus } from "./session-command-bus.js";
import { completionCoordinatorState } from "./completion-evidence-gate.js";

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

function failureFromSettlement(error: unknown, fallbackCode: string): RunOutcome {
  return {
    kind: "recoverable_failure",
    code: typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : fallbackCode,
    message: error instanceof Error ? error.message : String(error)
  };
}

async function applyFinishHooks(
  hooks: RuntimeHookCoordinator,
  session: RuntimeSession,
  outcome: RunOutcome
): Promise<RunOutcome> {
  try {
    if (outcome.kind === "completed") {
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
  if (outcome.kind === "completed") return "run.completed";
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
  const payload = outcome.kind === "completed"
    ? { ...outcome, coordinator: {
        modelStopped: true as const,
        assuranceSatisfied: true as const,
        reviewSatisfied: true as const,
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
  if (outcome.kind === "completed") return;
  await options.cancelChildren?.(session.identity.sessionId, `Parent run ended as ${outcome.kind}.`);
}

async function settleBeforeTerminalEvent(
  options: RuntimeSessionFinishOptions,
  session: RuntimeSession,
  outcome: RunOutcome
): Promise<RunOutcome> {
  let settled = outcome;
  try {
    await options.beforeOutcome?.(session, settled);
  } catch (error) {
    settled = failureFromSettlement(error, "process_settlement_failed");
  }
  try {
    await cancelChildrenAfterFailure(options, session, settled);
  } catch (error) {
    settled = failureFromSettlement(error, "child_settlement_failed");
  }
  return settled;
}

async function finishPostCommit(
  options: RuntimeSessionFinishOptions,
  session: RuntimeSession,
  runId: string,
  outcome: RunOutcome
): Promise<void> {
  // The appended terminal event is the durable source of truth. Record it
  // before snapshot compaction or lease release so a failure in either
  // maintenance operation cannot manufacture a second outcome. The waiter is
  // resolved after those best-effort operations to preserve the lease handoff
  // ordering required by immediate resume in another runtime.
  session.recovery.lastOutcome = outcome;
  try {
    await options.events.writeSnapshot(session);
  } catch {
    // A snapshot is an optimization; recovery can replay the committed event.
  }
  if (session.interaction.followUps.length === 0) {
    try {
      await options.commandBus.release(session.identity.sessionId);
    } catch {
      // releaseSession retries lease cleanup. The committed terminal outcome
      // must remain authoritative even if that best-effort release fails.
    }
  }
  resolveOutcomeWaiters(session, runId, outcome);
}

export async function finishRuntimeSession(
  options: RuntimeSessionFinishOptions,
  session: RuntimeSession,
  outcome: RunOutcome,
  outcomeRevision?: number,
  suspensionContext?: RunSuspensionContext
): Promise<boolean> {
  if (!isCurrentOutcomeRevision(session, outcomeRevision)) return false;
  const coordinator = outcome.kind === "completed" ? completionCoordinatorState(session) : undefined;
  const coordinatedOutcome = coordinator && !coordinator.runCompleted ? {
    kind: "recoverable_failure" as const,
    code: "completion_coordinator_rejected",
    message: `Model stopped, but completion gates remain unsatisfied (assurance=${coordinator.assuranceSatisfied}, review=${coordinator.reviewSatisfied}).`
  } : outcome;
  const hookedOutcome = await applyFinishHooks(options.hooks, session, coordinatedOutcome);
  if (outcomeRevision !== undefined && session.durable.state.phase !== "outcome_pending") return false;
  const finalOutcome = await settleBeforeTerminalEvent(options, session, hookedOutcome);
  if (outcomeRevision !== undefined && session.durable.state.phase !== "outcome_pending") return false;
  const commitRevision = outcomeRevision === undefined ? undefined : session.durable.state.revision;
  const event = await emitOutcome(options, session, finalOutcome, commitRevision, suspensionContext);
  if (!event || session.durable.state.lastSeq !== event.seq || !outcomeWasCommitted(session, finalOutcome)) return false;
  await finishPostCommit(options, session, event.runId, finalOutcome);
  return true;
}
