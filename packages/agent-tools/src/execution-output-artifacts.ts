import { createHash, randomUUID } from "node:crypto";
import type {
  ExecutionBroker,
  ExecutionResult,
  ProcessOutputArtifact,
  ProcessPollResult
} from "agent-execution";
import type {
  ArtifactRef,
  EvidenceRecord,
  ToolCallPlan,
  ToolDescriptor,
  ToolExecutionContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";

interface ImportedOutputArtifacts {
  brokerIds: string[];
  ids: string[];
  refs: ArtifactRef[];
  byStream: Partial<Record<"stdout" | "stderr", string>>;
  metadata: Array<{
    artifactId: string;
    name: string;
    stream: "stdout" | "stderr";
    complete: boolean;
    redactionLossy: boolean;
    mediaType: ProcessOutputArtifact["mediaType"];
  }>;
  diagnostics: string[];
}

const MODEL_STREAM_LIMIT_BYTES = 16 * 1024;
const MODEL_STREAM_EDGE_BYTES = 8 * 1024;

interface ProjectedStream {
  value: string;
  droppedBytes: number;
}

function projectStream(value: string): ProjectedStream {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MODEL_STREAM_LIMIT_BYTES) return { value, droppedBytes: 0 };
  let head = bytes.subarray(0, MODEL_STREAM_EDGE_BYTES).toString("utf8");
  let tail = bytes.subarray(bytes.byteLength - MODEL_STREAM_EDGE_BYTES).toString("utf8");
  while (Buffer.byteLength(head) + Buffer.byteLength(tail) > MODEL_STREAM_LIMIT_BYTES) {
    if (Buffer.byteLength(head) >= Buffer.byteLength(tail)) head = head.slice(0, -1);
    else tail = tail.slice(1);
  }
  const projected = `${head}${tail}`;
  return {
    value: projected,
    droppedBytes: bytes.byteLength - Buffer.byteLength(projected)
  };
}

async function preserveProjectedStream(
  stream: "stdout" | "stderr",
  original: string,
  projected: ProjectedStream,
  context: ToolExecutionContext,
  imported: ImportedOutputArtifacts
): Promise<void> {
  if (projected.droppedBytes === 0) return;
  if (!imported.byStream[stream]) {
    const content = Buffer.from(original, "utf8");
    const name = `${stream}-full.log`;
    const artifactId = await context.createArtifact({ name, content });
    imported.ids.push(artifactId);
    imported.refs.push({
      artifactId,
      name,
      digest: createHash("sha256").update(content).digest("hex"),
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: content.byteLength
    });
    imported.byStream[stream] = artifactId;
    imported.metadata.push({
      artifactId, name, stream, complete: true, redactionLossy: false,
      mediaType: "text/plain; charset=utf-8"
    });
    imported.diagnostics.push(`full_output_artifact:${stream}:${artifactId}`);
  }
  imported.diagnostics.push(`model_output_truncated:${stream}:${String(projected.droppedBytes)}`);
}

function commandSucceeded(result: ExecutionResult): boolean {
  return result.state === "exited" && result.exitCode === 0 && result.signal === null
    && !result.timedOut && !result.idleTimedOut && !result.cancelled
    && result.failure === undefined;
}

/** Stable, language-level diagnostics only. Package names and command text are
 * deliberately excluded so convergence remains product- and task-invariant. */
function dependencyDiagnostics(result: ExecutionResult): string[] {
  if (commandSucceeded(result)) return [];
  const output = `${result.stdout}\n${result.stderr}`;
  const missing = [
    /ModuleNotFoundError:\s*No module named/iu,
    /(?:Error:\s*)?Cannot find (?:package|module)\b/iu,
    /ERR_MODULE_NOT_FOUND/iu,
    /cannot load such file --/iu,
    /ClassNotFoundException\b/iu,
    /NoClassDefFoundError\b/iu
  ].some((pattern) => pattern.test(output));
  // This is the invoked application reporting a missing package, not the
  // execution broker failing to start. Keep it model-visible without feeding
  // the infrastructure fail-fast taxonomy.
  return missing ? ["command_dependency_missing"] : [];
}

function readonlyFilesystemDiagnostic(
  result: ExecutionResult,
  actualEffects: ToolCallPlan["exactEffects"]
): string[] {
  if (commandSucceeded(result) || actualEffects.includes("filesystem.write")) return [];
  const output = `${result.stdout}\n${result.stderr}`;
  return /\bread-only file system\b/iu.test(output)
    ? ["command_readonly_filesystem"]
    : [];
}

function readonlyFilesystemHint(diagnostics: readonly string[]): string {
  if (!diagnostics.includes("command_readonly_filesystem")) return "";
  return "Sigma hint: this call had read-only workspace access. If the failed write belongs in the workspace, re-run with expectedChanges listing exact files or a narrow directory. Put disposable outputs in the process temp directory.";
}

async function importOutputArtifacts(
  artifacts: readonly ProcessOutputArtifact[] | undefined,
  context: ToolExecutionContext
): Promise<ImportedOutputArtifacts> {
  const imported: ImportedOutputArtifacts = {
    brokerIds: [], ids: [], refs: [], byStream: {}, metadata: [], diagnostics: []
  };
  for (const artifact of artifacts ?? []) {
    const artifactId = await context.createArtifact({ name: artifact.name, content: artifact.content });
    const digest = createHash("sha256").update(artifact.content).digest("hex");
    imported.brokerIds.push(artifact.brokerArtifactId);
    imported.ids.push(artifactId);
    imported.refs.push({
      artifactId,
      name: artifact.name,
      digest,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.content.byteLength
    });
    imported.byStream[artifact.stream] = artifactId;
    imported.metadata.push({
      artifactId,
      name: artifact.name,
      stream: artifact.stream,
      complete: artifact.complete,
      redactionLossy: artifact.redactionLossy,
      mediaType: artifact.mediaType
    });
    imported.diagnostics.push(`full_output_artifact:${artifact.stream}:${artifactId}`);
    if (!artifact.complete) imported.diagnostics.push(`output_artifact_incomplete:${artifact.stream}`);
    if (artifact.redactionLossy) imported.diagnostics.push(`output_artifact_redaction_lossy:${artifact.stream}`);
  }
  return imported;
}

async function acknowledge(imported: ImportedOutputArtifacts, broker: ExecutionBroker): Promise<void> {
  if (imported.brokerIds.length === 0 || !broker.releaseOutputArtifacts) return;
  try {
    await broker.releaseOutputArtifacts(imported.brokerIds);
  } catch {
    imported.diagnostics.push("output_artifact_release_failed");
  }
}

function decodingDiagnostics(
  result: Pick<ExecutionResult, "outputDecodingErrors">
): string[] {
  return (result.outputDecodingErrors ?? []).map((item) =>
    `${item.code}:${item.stream}`);
}

function commandEvidence(
  request: ToolRequest,
  command: string,
  result: ExecutionResult,
  validation: boolean,
  completedAt: string,
  context: ToolExecutionContext,
  imported: ImportedOutputArtifacts
): EvidenceRecord {
  const base = {
    evidenceId: randomUUID(), sessionId: context.sessionId, runId: context.runId,
    status: commandSucceeded(result) ? "passed" as const : "failed" as const,
    createdAt: completedAt, producer: { authority: "tool" as const, id: request.callId }
  };
  if (validation) return {
    ...base, kind: "validation", summary: `Validation '${command}' exited with ${String(result.exitCode)}.`,
    data: {
      schemaVersion: 1,
      validator: "command", command, exitCode: result.exitCode,
      termination: {
        processStarted: result.failure === undefined,
        state: result.state,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        idleTimedOut: result.idleTimedOut,
        cancelled: result.cancelled,
        ...(result.failure ? { failureCode: result.failure.code } : {})
      },
      artifactIds: imported.ids,
      // The runtime replaces this preparation-time placeholder with the
      // frozen mutation-frontier identity before evidence is emitted.
      frontierRevision: 0,
      stateDigest: "0".repeat(64),
      coveredPaths: []
    }
  };
  return {
    ...base, kind: "command", summary: `Command '${command}' exited with ${String(result.exitCode)}.`,
    data: {
      command, exitCode: result.exitCode, ...(result.signal ? { signal: result.signal } : {}),
      artifactIds: imported.ids,
      ...(imported.byStream.stdout ? { stdoutArtifactId: imported.byStream.stdout } : {}),
      ...(imported.byStream.stderr ? { stderrArtifactId: imported.byStream.stderr } : {})
    }
  };
}

export async function commandReceipt(
  request: ToolRequest,
  startedAt: string,
  command: string,
  result: ExecutionResult,
  validation: boolean,
  actualEffects: ToolCallPlan["exactEffects"],
  context: ToolExecutionContext,
  broker: ExecutionBroker
): Promise<ToolReceipt> {
  const completedAt = new Date().toISOString();
  const ok = commandSucceeded(result);
  const imported = await importOutputArtifacts(result.outputArtifacts, context);
  const stdout = projectStream(result.stdout);
  const stderr = projectStream(result.stderr);
  await preserveProjectedStream("stdout", result.stdout, stdout, context, imported);
  await preserveProjectedStream("stderr", result.stderr, stderr, context, imported);
  await acknowledge(imported, broker);
  const evidence = commandEvidence(request, command, result, validation, completedAt, context, imported);
  const readonlyDiagnostics = readonlyFilesystemDiagnostic(result, actualEffects);
  const output = [
    stdout.value,
    stderr.value,
    readonlyFilesystemHint(readonlyDiagnostics)
  ].filter(Boolean).join("\n");
  const diagnostics = [
    `exit_code=${String(result.exitCode)}`,
    ...(result.failure ? [result.failure.code] : []),
    ...dependencyDiagnostics(result),
    ...readonlyDiagnostics,
    ...(result.outputTruncated ? ["output_truncated"] : []), ...imported.diagnostics,
    ...decodingDiagnostics(result),
    ...(result.timedOut || result.idleTimedOut ? ["process_timed_out"] : [])
  ];
  return {
    callId: request.callId, ok,
    output,
    outcome: { status: ok ? "succeeded" : "failed", output, diagnosticCodes: diagnostics },
    observedEffects: [...actualEffects], actualEffects: [...actualEffects],
    artifacts: imported.ids, artifactRefs: imported.refs,
    diagnostics,
    evidence: [evidence], startedAt, completedAt
  };
}

function processOutcome(
  operation: "poll" | "terminate",
  value: ProcessPollResult
): { ok: boolean; diagnostics: string[] } {
  if (operation === "terminate") return { ok: true, diagnostics: [] };
  if (value.state === "running") return { ok: true, diagnostics: [] };
  if (value.state === "lost") return { ok: false, diagnostics: ["process_lost"] };
  if (value.state === "terminated") return { ok: false, diagnostics: ["process_terminated"] };
  const diagnostics = [
    ...(value.exitCode === 0 ? [] : [`process_exit_nonzero:${String(value.exitCode)}`]),
    ...(value.signal === null ? [] : [`process_signalled:${value.signal}`])
  ];
  return { ok: diagnostics.length === 0, diagnostics };
}

export async function processReceipt(
  request: ToolRequest,
  startedAt: string,
  value: ProcessPollResult,
  effects: ToolDescriptor["possibleEffects"],
  context: ToolExecutionContext,
  broker: ExecutionBroker,
  operation: "poll" | "terminate"
): Promise<ToolReceipt> {
  const completedAt = new Date().toISOString();
  const imported = await importOutputArtifacts(value.outputArtifacts, context);
  const stdout = projectStream(value.stdout);
  const stderr = projectStream(value.stderr);
  await preserveProjectedStream("stdout", value.stdout, stdout, context, imported);
  await preserveProjectedStream("stderr", value.stderr, stderr, context, imported);
  await acknowledge(imported, broker);
  const outputValue = {
    ...value,
    stdout: stdout.value,
    stderr: stderr.value,
    ...(imported.metadata.length > 0 ? { outputArtifacts: imported.metadata } : {})
  };
  const evidence: EvidenceRecord[] = imported.metadata.length === 0 ? [] : [{
    evidenceId: randomUUID(), sessionId: context.sessionId, runId: context.runId,
    kind: "diagnostic",
    status: imported.metadata.some((artifact) => !artifact.complete || artifact.redactionLossy)
      ? "warning" : "informational",
    createdAt: completedAt, producer: { authority: "tool", id: request.callId },
    summary: "Bounded or non-text broker output was preserved as redacted durable artifacts.",
    data: { source: "sigma-exec", diagnostic: { type: "process_output_artifacts", artifacts: imported.metadata } }
  }];
  const outcome = processOutcome(operation, value);
  const ok = value.failure === undefined && outcome.ok;
  const output = JSON.stringify(
    outputValue,
    (_key, item: unknown) => item instanceof Uint8Array ? undefined : item
  );
  const diagnostics = [
    ...(value.failure ? [value.failure.code] : []),
    ...outcome.diagnostics,
    ...(value.outputTruncated ? ["output_truncated"] : []),
    ...decodingDiagnostics(value),
    ...imported.diagnostics
  ];
  return {
    callId: request.callId, ok,
    output,
    outcome: { status: ok ? "succeeded" : "failed", output, diagnosticCodes: diagnostics },
    observedEffects: effects, actualEffects: effects,
    artifacts: imported.ids, artifactRefs: imported.refs,
    diagnostics,
    evidence, startedAt, completedAt
  };
}
