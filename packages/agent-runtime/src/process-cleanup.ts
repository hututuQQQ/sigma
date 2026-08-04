import type { RunOutcome } from "agent-protocol";
import type { ProcessHandle, ProcessPollResult } from "agent-execution";
import type { ProcessExecutionPort } from "agent-platform";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

async function emitOutput(
  session: RuntimeSession,
  processId: string,
  stream: "stdout" | "stderr",
  chunk: string,
  emit: RuntimeEventEmitter
): Promise<number> {
  if (!chunk) return 0;
  await emit(session, "process.output", "runtime", { processId, stream, chunk });
  return 1;
}

interface TerminationAttempt {
  handle: ProcessHandle;
  result?: ProcessPollResult;
  error?: unknown;
}

async function terminateConcurrently(
  handles: readonly ProcessHandle[],
  execution: ProcessExecutionPort,
  signal?: AbortSignal
): Promise<TerminationAttempt[]> {
  return await Promise.all(handles.map(async (handle) => {
    try {
      const result = await execution.terminate!(handle, {
        timeoutMs: 10_000,
        ...(signal ? { signal } : {})
      });
      const artifactIds = result.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
      if (artifactIds.length > 0) {
        await execution.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
      }
      return { handle, result };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { handle, error };
    }
  }));
}

async function recordTerminations(
  session: RuntimeSession,
  attempts: readonly TerminationAttempt[],
  reason: string,
  emit: RuntimeEventEmitter
): Promise<number> {
  let emitted = 0;
  for (const { handle, result, error } of attempts) {
    if (result) {
      emitted += await emitOutput(session, handle.id, "stdout", result.stdout, emit);
      emitted += await emitOutput(session, handle.id, "stderr", result.stderr, emit);
      await emit(session, "process.exited", "runtime", {
        processId: handle.id,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        state: result.state,
        reason
      });
    } else {
      await emit(session, "process.lost", "runtime", {
        processId: handle.id,
        reason: `${reason} failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    emitted += 1;
    session.execution.processHandles.delete(handle.id);
  }
  return emitted;
}

async function terminateHandles(
  session: RuntimeSession,
  handles: readonly ProcessHandle[],
  execution: ProcessExecutionPort,
  emit: RuntimeEventEmitter,
  reason: string,
  signal?: AbortSignal
): Promise<number> {
  const attempts = await terminateConcurrently(handles, execution, signal);
  return await recordTerminations(session, attempts, reason, emit);
}

/**
 * Natural completion owns cleanup of ordinary session-lifecycle processes.
 * Deliverables remain model-owned until an explicit verified handoff, so the
 * completion gate can still reject an accidentally abandoned service.
 */
export async function settleSessionProcessesForCompletion(
  session: RuntimeSession,
  execution: ProcessExecutionPort | undefined,
  emit: RuntimeEventEmitter,
  signal: AbortSignal
): Promise<number> {
  const handles = [...session.execution.processHandles.values()]
    .filter((handle) => (handle.lifecycle ?? "session") === "session");
  if (handles.length === 0 || !execution?.terminate) return 0;
  return await terminateHandles(
    session, handles, execution, emit, "run_completed_session_settlement", signal
  );
}

/** Ensures a terminal run never leaves runtime-local background work behind. */
export async function terminateRunProcesses(
  session: RuntimeSession,
  outcome: RunOutcome,
  execution: ProcessExecutionPort | undefined,
  emit: RuntimeEventEmitter
): Promise<number> {
  if (outcome.kind === "needs_input" || !session.execution.processHandles?.size) return 0;
  if (!execution?.terminate) {
    throw Object.assign(new Error("Cannot finish a run with active processes because the execution broker cannot terminate them."), {
      code: "process_termination_unavailable"
    });
  }
  return await terminateHandles(
    session,
    [...session.execution.processHandles.values()],
    execution,
    emit,
    `run_${outcome.kind}`
  );
}
