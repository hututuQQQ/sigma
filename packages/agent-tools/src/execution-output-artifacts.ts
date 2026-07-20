import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
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
import { dependencyDiagnostics } from "./execution-diagnostics.js";

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
      artifactId, name, stream, complete: true, redactionLossy: false
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

function workspaceRelative(root: string, candidate: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ? relative || "." : undefined;
}

const QUOTE_PAIRS = new Map([
  ["'", "'"], ["\"", "\""], ["`", "`"], ["‘", "’"], ["“", "”"]
]);

function normalizedErofsTarget(value: string, explicitOperation = false): string | undefined {
  const candidate = value.trim();
  const closingQuote = QUOTE_PAIRS.get(candidate[0] ?? "");
  const unquoted = closingQuote && candidate.endsWith(closingQuote)
    ? candidate.slice(1, -closingQuote.length).trim()
    : candidate;
  if (!unquoted || unquoted.includes("\0") || /[\r\n]/u.test(unquoted)) return undefined;
  if (closingQuote) return unquoted;
  if (/\s|['"`‘’“”]/u.test(unquoted)) return undefined;
  // A coreutils operation names its operand unambiguously. For generic
  // `program: value: EROFS` diagnostics, require path syntax so words such as
  // "error" or "EROFS" cannot be mistaken for a recoverable target.
  return explicitOperation || /[./\\]/u.test(unquoted) ? unquoted : undefined;
}

function erofsTarget(stderr: string): string | undefined {
  const node = stderr.match(/\bEROFS:\s*read-only file system,\s*[^'"`\r\n]*(['"`])([^'"`\r\n]+)\1/iu);
  if (node?.[2]) return normalizedErofsTarget(`'${node[2]}'`);
  const python = stderr.match(/\[Errno\s+30\]\s*Read-only file system:\s*(['"`])([^'"`\r\n]+)\1/iu);
  if (python?.[2]) return normalizedErofsTarget(`'${python[2]}'`);

  const diagnostic = stderr.match(/(?:^|\r?\n)[^:\r\n]+:\s+(.+):\s+Read-only file system\s*(?=$|\r?\n)/iu);
  if (!diagnostic?.[1]) return undefined;
  const operation = diagnostic[1].match(
    /^cannot\s+(?:touch|create(?:\s+(?:regular\s+file|directory))?|open|write(?:\s+to)?)\s+(.+)$/iu
  );
  return normalizedErofsTarget(operation?.[1] ?? diagnostic[1], Boolean(operation));
}

function permissionDeniedTarget(stderr: string): string | undefined {
  const node = stderr.match(/\b(?:EACCES|EPERM):\s*permission denied,\s*[^'"`\r\n]*(['"`])([^'"`\r\n]+)\1/iu);
  if (node?.[2]) return normalizedErofsTarget(`'${node[2]}'`);
  const python = stderr.match(/\[Errno\s+13\]\s*Permission denied:\s*(['"`])([^'"`\r\n]+)\1/iu);
  return python?.[2] ? normalizedErofsTarget(`'${python[2]}'`) : undefined;
}

function scopedWorkspaceWriteFailureTarget(
  request: ToolRequest,
  result: ExecutionResult,
  context: ToolExecutionContext,
  includePermissionDenied: boolean
): string | undefined {
  if (result.exitCode === 0) return undefined;
  const target = erofsTarget(result.stderr)
    ?? (includePermissionDenied ? permissionDeniedTarget(result.stderr) : undefined);
  if (!target) return undefined;
  const args = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)
    ? request.arguments as Record<string, unknown> : {};
  const requestedCwd = typeof args.cwd === "string" ? args.cwd : context.workspacePath;
  const cwd = path.isAbsolute(requestedCwd)
    ? path.resolve(requestedCwd) : path.resolve(context.workspacePath, requestedCwd);
  if (workspaceRelative(context.workspacePath, cwd) === undefined) return undefined;
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  return workspaceRelative(context.workspacePath, resolved);
}

/** Emit recovery guidance only when the failed process named a target that
 * resolves inside the active workspace. An arbitrary EROFS string or a write
 * to a system/external root is not evidence that a workspace mutation lease
 * can recover the command. Validation already has a disposable writable copy
 * and therefore never receives this advisory. */
function recoverableWriteContractTarget(
  request: ToolRequest,
  result: ExecutionResult,
  validation: boolean,
  actualEffects: ToolCallPlan["exactEffects"],
  context: ToolExecutionContext
): string | undefined {
  if (validation || actualEffects.includes("filesystem.write") || result.exitCode === 0) return undefined;
  return scopedWorkspaceWriteFailureTarget(request, result, context, false);
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
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: artifact.content.byteLength
    });
    imported.byStream[artifact.stream] = artifactId;
    imported.metadata.push({
      artifactId,
      name: artifact.name,
      stream: artifact.stream,
      complete: artifact.complete,
      redactionLossy: artifact.redactionLossy
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

function commandEvidence(
  request: ToolRequest,
  command: string,
  result: ExecutionResult,
  validation: boolean,
  completedAt: string,
  context: ToolExecutionContext,
  imported: ImportedOutputArtifacts,
  validationCapabilityFailure = false
): EvidenceRecord {
  const base = {
    evidenceId: randomUUID(), sessionId: context.sessionId, runId: context.runId,
    status: commandSucceeded(result) ? "passed" as const : "failed" as const,
    createdAt: completedAt, producer: { authority: "tool" as const, id: request.callId }
  };
  if (validation) return {
    ...base, kind: "validation", summary: `Validation '${command}' exited with ${String(result.exitCode)}.`,
    data: {
      validator: "command", command, exitCode: result.exitCode,
      termination: {
        processStarted: result.failure === undefined,
        state: result.state,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        idleTimedOut: result.idleTimedOut,
        cancelled: result.cancelled,
        ...(result.failure ? { failureCode: result.failure.code } : {}),
        ...(validationCapabilityFailure ? {
          failureCode: "validation_disposable_workspace_unavailable"
        } : {})
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
  broker: ExecutionBroker,
  readOnlyValidationFallback = false
): Promise<ToolReceipt> {
  const completedAt = new Date().toISOString();
  const ok = commandSucceeded(result);
  const imported = await importOutputArtifacts(result.outputArtifacts, context);
  const stdout = projectStream(result.stdout);
  const stderr = projectStream(result.stderr);
  await preserveProjectedStream("stdout", result.stdout, stdout, context, imported);
  await preserveProjectedStream("stderr", result.stderr, stderr, context, imported);
  await acknowledge(imported, broker);
  const validationCapabilityTarget = validation && readOnlyValidationFallback
    ? scopedWorkspaceWriteFailureTarget(request, result, context, true)
    : undefined;
  const evidence = commandEvidence(
    request, command, result, validation, completedAt, context, imported,
    validationCapabilityTarget !== undefined
  );
  const writeContractTarget = recoverableWriteContractTarget(
    request, result, validation, actualEffects, context
  );
  const writeContractAdvisory = writeContractTarget
    ? "[write_contract_required] The command attempted a workspace write without an approved mutation contract. Retry only with accurate expectedChanges so the runtime can grant a bounded, recoverable write lease."
    : undefined;
  const validationCapabilityAdvisory = validationCapabilityTarget
    ? "[validation_disposable_workspace_unavailable] This validation requires workspace writes, but the current target supports only explicit read-only validation at the real workspace path; no workspace data was granted writable access."
    : undefined;
  return {
    callId: request.callId, ok,
    output: [validationCapabilityAdvisory, writeContractAdvisory, stdout.value, stderr.value]
      .filter(Boolean).join("\n"),
    observedEffects: [...actualEffects], actualEffects: [...actualEffects],
    ...(validationCapabilityTarget ? { result: {
      status: "failed",
      code: "validation_disposable_workspace_unavailable",
      recoverable: false,
      scope: "workspace",
      target: validationCapabilityTarget
    } } : writeContractTarget ? { result: {
      status: "failed",
      code: "write_contract_required",
      recoverable: true,
      scope: "workspace",
      target: writeContractTarget
    } } : {}),
    artifacts: imported.ids, artifactRefs: imported.refs,
    diagnostics: [
      `exit_code=${String(result.exitCode)}`,
      ...(result.failure ? [result.failure.code] : []),
      ...(validationCapabilityTarget ? ["validation_disposable_workspace_unavailable"] : []),
      ...(writeContractTarget ? ["write_contract_required"] : []),
      ...dependencyDiagnostics(result),
      ...(result.outputTruncated ? ["output_truncated"] : []), ...imported.diagnostics,
      ...(result.timedOut || result.idleTimedOut ? ["process_timed_out"] : [])
    ],
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
    summary: "Broker output overflow was preserved as redacted durable artifacts.",
    data: { source: "sigma-exec", diagnostic: { type: "process_output_artifacts", artifacts: imported.metadata } }
  }];
  const outcome = processOutcome(operation, value);
  return {
    callId: request.callId, ok: value.failure === undefined && outcome.ok,
    output: JSON.stringify(outputValue, (_key, item: unknown) => item instanceof Uint8Array ? undefined : item),
    observedEffects: effects, actualEffects: effects,
    artifacts: imported.ids, artifactRefs: imported.refs,
    diagnostics: [
      ...(value.failure ? [value.failure.code] : []),
      ...outcome.diagnostics,
      ...(value.outputTruncated ? ["output_truncated"] : []),
      ...imported.diagnostics
    ],
    evidence, startedAt, completedAt
  };
}
