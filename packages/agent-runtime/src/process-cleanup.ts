import type { RunOutcome } from "agent-protocol";
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
  let emitted = 0;
  for (const handle of [...session.execution.processHandles.values()]) {
    try {
      const result = await execution.terminate(handle, { timeoutMs: 10_000 });
      const artifactIds = result.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
      if (artifactIds.length > 0) {
        await execution.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
      }
      emitted += await emitOutput(session, handle.id, "stdout", result.stdout, emit);
      emitted += await emitOutput(session, handle.id, "stderr", result.stderr, emit);
      await emit(session, "process.exited", "runtime", {
        processId: handle.id,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        state: result.state,
        reason: `run_${outcome.kind}`
      });
      emitted += 1;
    } catch (error) {
      await emit(session, "process.lost", "runtime", {
        processId: handle.id,
        reason: `Termination during ${outcome.kind} failed: ${error instanceof Error ? error.message : String(error)}`
      });
      emitted += 1;
    } finally {
      session.execution.processHandles.delete(handle.id);
    }
  }
  return emitted;
}

export async function settleRunProcessesAndScratch(
  session: RuntimeSession,
  outcome: RunOutcome,
  execution: ProcessExecutionPort | undefined,
  emit: RuntimeEventEmitter
): Promise<number> {
  const emitted = await terminateRunProcesses(session, outcome, execution, emit);
  // Scratch belongs to the RuntimeSession, not an individual run. Completed,
  // failed, and blocked runs may all be followed up in the same session.
  // Cancellation is the one run outcome that explicitly retires the lease;
  // ordinary session destruction releases it through releaseSession.
  if (outcome.kind === "cancelled") {
    await execution?.releaseScratchLease?.(session.identity.sessionId);
  }
  return emitted;
}
