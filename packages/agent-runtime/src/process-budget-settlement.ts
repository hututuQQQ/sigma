import { createHash, randomUUID } from "node:crypto";
import type { ProcessHandle, ProcessOutputArtifact, ProcessPollResult } from "agent-execution";
import type { DiagnosticEvidence } from "agent-protocol";
import type { ProcessExecutionPort } from "agent-platform";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

const PROCESS_POLL_INTERVAL_MS = 250;
const OUTPUT_PREVIEW_CHARS = 4_096;

interface StreamSummary {
  hash: ReturnType<typeof createHash>;
  byteLength: number;
  preview: string;
}

interface ProcessSettlementSummary {
  stdout: StreamSummary;
  stderr: StreamSummary;
  artifactIds: string[];
  importedBrokerArtifactIds: Set<string>;
}

export interface BudgetBoundaryProcessSettlement {
  attempted: number;
  settled: number;
  unavailable: boolean;
}

export interface BudgetBoundaryProcessSettlementOptions {
  execution?: ProcessExecutionPort;
  emit: RuntimeEventEmitter;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
}

function emptyStreamSummary(): StreamSummary {
  return {
    hash: createHash("sha256"),
    byteLength: 0,
    preview: ""
  };
}

function emptyProcessSummary(): ProcessSettlementSummary {
  return {
    stdout: emptyStreamSummary(),
    stderr: emptyStreamSummary(),
    artifactIds: [],
    importedBrokerArtifactIds: new Set()
  };
}

function appendPreview(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  if (combined.length <= OUTPUT_PREVIEW_CHARS) return combined;
  const edge = Math.floor((OUTPUT_PREVIEW_CHARS - 32) / 2);
  return `${combined.slice(0, edge)}\n[... omitted ...]\n${combined.slice(-edge)}`;
}

function accountStream(summary: StreamSummary, chunk: string): void {
  if (!chunk) return;
  const bytes = Buffer.from(chunk, "utf8");
  summary.hash.update(bytes);
  summary.byteLength += bytes.byteLength;
  summary.preview = appendPreview(summary.preview, chunk);
}

async function delay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, PROCESS_POLL_INTERVAL_MS);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Run cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  signal.throwIfAborted();
}

async function preserveArtifacts(
  session: RuntimeSession,
  artifacts: readonly ProcessOutputArtifact[] | undefined,
  summary: ProcessSettlementSummary,
  options: BudgetBoundaryProcessSettlementOptions
): Promise<void> {
  const releasable: string[] = [];
  for (const artifact of artifacts ?? []) {
    if (summary.importedBrokerArtifactIds.has(artifact.brokerArtifactId)) continue;
    const artifactId = await options.createArtifact(
      session.identity.sessionId,
      artifact.content
    );
    summary.importedBrokerArtifactIds.add(artifact.brokerArtifactId);
    releasable.push(artifact.brokerArtifactId);
    summary.artifactIds.push(artifactId);
  }
  if (releasable.length > 0) {
    await options.execution?.releaseOutputArtifacts?.(
      releasable
    ).catch(() => undefined);
  }
}

async function recordOutput(
  session: RuntimeSession,
  processId: string,
  result: ProcessPollResult,
  summary: ProcessSettlementSummary,
  options: BudgetBoundaryProcessSettlementOptions
): Promise<void> {
  for (const stream of ["stdout", "stderr"] as const) {
    const chunk = result[stream];
    accountStream(summary[stream], chunk);
    if (chunk) {
      await options.emit(session, "process.output", "runtime", {
        processId,
        stream,
        chunk
      });
    }
  }
  await preserveArtifacts(session, result.outputArtifacts, summary, options);
}

function settlementEvidence(
  session: RuntimeSession,
  handle: ProcessHandle,
  result: ProcessPollResult,
  summary: ProcessSettlementSummary
): DiagnosticEvidence {
  const succeeded = result.state === "exited"
    && result.exitCode === 0
    && result.signal === null
    && result.failure === undefined;
  return {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "diagnostic",
    status: succeeded ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: `process-settlement:${handle.id}` },
    summary: succeeded
      ? "A session-owned background process settled successfully before completion review."
      : "A session-owned background process settled unsuccessfully before completion review.",
    data: {
      source: "background_process_settlement",
      diagnostic: {
        schemaVersion: 1,
        processId: handle.id,
        lifecycle: handle.lifecycle ?? "session",
        state: result.state,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        failure: result.failure
          ? {
              phase: result.failure.phase,
              code: result.failure.code,
              message: result.failure.message
            }
          : null,
        outputTruncated: result.outputTruncated,
        outputArtifactIds: summary.artifactIds,
        stdout: {
          sha256: summary.stdout.hash.digest("hex"),
          byteLength: summary.stdout.byteLength,
          preview: summary.stdout.preview
        },
        stderr: {
          sha256: summary.stderr.hash.digest("hex"),
          byteLength: summary.stderr.byteLength,
          preview: summary.stderr.preview
        }
      }
    }
  };
}

async function recordLost(
  session: RuntimeSession,
  handle: ProcessHandle,
  error: unknown,
  summary: ProcessSettlementSummary,
  options: BudgetBoundaryProcessSettlementOptions
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  session.execution.processHandles.delete(handle.id);
  await options.emit(session, "process.lost", "runtime", {
    processId: handle.id,
    reason: message
  });
  await options.emit(session, "evidence.recorded", "runtime", {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "diagnostic",
    status: "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: `process-settlement:${handle.id}` },
    summary: "A session-owned background process was lost before completion review.",
    data: {
      source: "background_process_settlement",
      diagnostic: {
        schemaVersion: 1,
        processId: handle.id,
        lifecycle: handle.lifecycle ?? "session",
        state: "lost",
        exitCode: null,
        signal: null,
        durationMs: null,
        failure: { code: "process_poll_failed", message },
        outputTruncated: false,
        outputArtifactIds: summary.artifactIds,
        stdout: {
          sha256: summary.stdout.hash.digest("hex"),
          byteLength: summary.stdout.byteLength,
          preview: summary.stdout.preview
        },
        stderr: {
          sha256: summary.stderr.hash.digest("hex"),
          byteLength: summary.stderr.byteLength,
          preview: summary.stderr.preview
        }
      }
    }
  } satisfies DiagnosticEvidence);
}

/**
 * At ordinary solver-budget exhaustion, wait for already-started,
 * session-owned work to settle before invoking independent verification.
 * This is lifecycle settlement rather than a new solving action: it creates
 * no model turn, consults no task semantics, and remains cancellable by the
 * outer run deadline.
 */
export async function settleBudgetBoundaryProcesses(
  session: RuntimeSession,
  signal: AbortSignal,
  options: BudgetBoundaryProcessSettlementOptions
): Promise<BudgetBoundaryProcessSettlement> {
  const pending = new Map(
    [...session.execution.processHandles.values()]
      .filter((handle) => (handle.lifecycle ?? "session") === "session")
      .map((handle) => [handle.id, handle] as const)
  );
  if (pending.size === 0) {
    return { attempted: 0, settled: 0, unavailable: false };
  }
  if (!options.execution?.poll) {
    return { attempted: pending.size, settled: 0, unavailable: true };
  }
  const summaries = new Map([...pending.keys()].map((id) =>
    [id, emptyProcessSummary()] as const));
  let settled = 0;
  while (pending.size > 0) {
    signal.throwIfAborted();
    for (const [id, handle] of [...pending.entries()]) {
      let result: ProcessPollResult;
      try {
        result = await options.execution.poll(handle, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        await recordLost(session, handle, error, summaries.get(id)!, options);
        pending.delete(id);
        settled += 1;
        continue;
      }
      const summary = summaries.get(id)!;
      await recordOutput(session, id, result, summary, options);
      if (result.state === "running") continue;
      session.execution.processHandles.delete(id);
      pending.delete(id);
      settled += 1;
      if (result.state === "lost") {
        await options.emit(session, "process.lost", "runtime", {
          processId: id,
          reason: "The execution broker reported the process as lost during budget-boundary settlement."
        });
      } else {
        await options.emit(session, "process.exited", "runtime", {
          processId: id,
          exitCode: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
          state: result.state,
          reason: "budget_boundary_settlement"
        });
      }
      await options.emit(
        session,
        "evidence.recorded",
        "runtime",
        settlementEvidence(session, handle, result, summary)
      );
    }
    if (pending.size > 0) await delay(signal);
  }
  return {
    attempted: summaries.size,
    settled,
    unavailable: false
  };
}

/**
 * A deliverable process remains runtime-owned until an explicit handoff. Once
 * the ordinary solving budget is exhausted, no model turn remains to perform
 * that handoff, and every terminal outcome would terminate the process anyway.
 * Terminate these unhanded processes before the completion gate so a normal
 * resource boundary cannot be misreported as an agent crash.
 */
export async function terminateUnhandedBudgetBoundaryProcesses(
  session: RuntimeSession,
  signal: AbortSignal,
  options: BudgetBoundaryProcessSettlementOptions
): Promise<BudgetBoundaryProcessSettlement> {
  const pending = [...session.execution.processHandles.values()]
    .filter((handle) => handle.lifecycle === "deliverable");
  if (pending.length === 0) {
    return { attempted: 0, settled: 0, unavailable: false };
  }
  if (!options.execution?.terminate) {
    return { attempted: pending.length, settled: 0, unavailable: true };
  }
  let settled = 0;
  for (const handle of pending) {
    signal.throwIfAborted();
    const summary = emptyProcessSummary();
    try {
      const result = await options.execution.terminate(handle, {
        signal,
        timeoutMs: 10_000
      });
      await recordOutput(session, handle.id, result, summary, options);
      session.execution.processHandles.delete(handle.id);
      await options.emit(session, "process.exited", "runtime", {
        processId: handle.id,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        state: result.state,
        reason: "budget_boundary_unhanded_deliverable"
      });
      await options.emit(
        session,
        "evidence.recorded",
        "runtime",
        settlementEvidence(session, handle, result, summary)
      );
    } catch (error) {
      if (signal.aborted) throw error;
      await recordLost(session, handle, error, summary, options);
    }
    settled += 1;
  }
  return {
    attempted: pending.length,
    settled,
    unavailable: false
  };
}
