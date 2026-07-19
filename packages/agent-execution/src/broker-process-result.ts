import type { ProcessRedaction } from "./broker-client-support.js";
import { SecretRedactor } from "./redaction.js";
import type { ProcessHandle, ProcessOutputArtifact, ProcessPollResult } from "./types.js";
import type { parseProcessValue } from "./values.js";

export function decodedProcessPollResult(
  handle: ProcessHandle,
  value: ReturnType<typeof parseProcessValue>,
  streams: ProcessRedaction,
  redactor: SecretRedactor,
  outputArtifacts: ProcessOutputArtifact[]
): ProcessPollResult {
  const final = value.state !== "running";
  const stdout = streams.stdout.push(value.stdout.data, {
    final, discontinuity: value.stdout.droppedBytes > 0
  });
  let stderr = streams.stderr.push(value.stderr.data, {
    final, discontinuity: value.stderr.droppedBytes > 0
  });
  const failure = value.failure ? {
    ...value.failure,
    message: redactor.redactText(value.failure.message)
  } : undefined;
  if (failure) stderr = `sigma-exec sandbox launch failed [${failure.code}]: ${failure.message}`;
  return {
    handle, state: value.state, exitCode: value.exitCode, signal: value.signal, durationMs: value.durationMs,
    stdout, stderr,
    stdoutDroppedBytes: value.stdout.droppedBytes, stderrDroppedBytes: value.stderr.droppedBytes,
    outputTruncated: value.stdout.droppedBytes > 0 || value.stderr.droppedBytes > 0,
    ...(failure ? { failure } : {}),
    ...(outputArtifacts.length > 0 ? { outputArtifacts } : {})
  };
}
