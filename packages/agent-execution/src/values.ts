import { BrokerProtocolError } from "./errors.js";
import { protocolRecord } from "./protocol.js";
import { booleanValue, stringValue } from "./broker-value-primitives.js";
import {
  BROKER_PROTOCOL_VERSION,
  type ProcessLaunchFailureV1,
  type ProcessState
} from "./types.js";

export interface OutputChunkValue {
  data: string;
  nextOffset: number;
  droppedBytes: number;
  decodingError?: {
    code: "invalid_output_encoding" | "encoding_lossy";
    message: string;
  };
}

export interface OutputArtifactValue {
  artifactId: string;
  name: string;
  stream: "stdout" | "stderr";
  path: string;
  sha256: string;
  sizeBytes: number;
  complete: boolean;
  redacted: true;
  redactionLossy: boolean;
}

export interface ProcessValue {
  state: Exclude<ProcessState, "lost">;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: OutputChunkValue;
  stderr: OutputChunkValue;
  outputArtifacts: OutputArtifactValue[];
  failure?: ProcessLaunchFailureV1;
}

export interface ExecutionValue extends ProcessValue {
  state: "exited" | "terminated";
  timedOut: boolean;
  idleTimedOut: boolean;
  cancelled: boolean;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BrokerProtocolError(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function nullableExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new BrokerProtocolError("Process exitCode must be an integer or null.");
  return value as number;
}

function processLaunchFailure(input: unknown): ProcessLaunchFailureV1 | undefined {
  if (input === undefined) return undefined;
  const value = protocolRecord(input, "Process failure");
  if (value.phase !== "sandbox_launch") {
    throw new BrokerProtocolError("Process failure.phase must be 'sandbox_launch'.");
  }
  const code = stringValue(value.code, "Process failure.code");
  const message = stringValue(value.message, "Process failure.message");
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(code)) {
    throw new BrokerProtocolError("Process failure.code must be a stable lowercase code.");
  }
  if (message.length === 0 || message.length > 16_384 || message.includes("\0")) {
    throw new BrokerProtocolError("Process failure.message has an invalid length or content.");
  }
  return { phase: "sandbox_launch", code, message };
}

function outputChunk(input: unknown, label: string): OutputChunkValue {
  const value = protocolRecord(input, label);
  const rawDecodingError = value.decodingError;
  let decodingError: OutputChunkValue["decodingError"];
  if (rawDecodingError !== undefined && rawDecodingError !== null) {
    const error = protocolRecord(rawDecodingError, `${label}.decodingError`);
    if (error.code !== "invalid_output_encoding" && error.code !== "encoding_lossy") {
      throw new BrokerProtocolError(`${label}.decodingError.code is invalid.`);
    }
    decodingError = {
      code: error.code,
      message: stringValue(error.message, `${label}.decodingError.message`)
    };
  }
  return {
    data: stringValue(value.data, `${label}.data`),
    nextOffset: integerValue(value.nextOffset, `${label}.nextOffset`),
    droppedBytes: integerValue(value.droppedBytes, `${label}.droppedBytes`),
    ...(decodingError ? { decodingError } : {})
  };
}

function outputArtifacts(input: unknown): OutputArtifactValue[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 2) {
    throw new BrokerProtocolError("Process outputArtifacts must contain at most stdout and stderr artifacts.");
  }
  const seen = new Set<string>();
  const seenStreams = new Set<"stdout" | "stderr">();
  return input.map((raw, index) => {
    const value = protocolRecord(raw, `Process outputArtifacts[${index}]`);
    const artifactId = stringValue(value.artifactId, "Output artifactId");
    const name = stringValue(value.name, "Output artifact name");
    const stream = value.stream;
    const sha256 = stringValue(value.sha256, "Output artifact sha256");
    if (!/^[a-zA-Z0-9._-]{1,256}$/u.test(artifactId) || seen.has(artifactId)) {
      throw new BrokerProtocolError("Output artifactId is invalid or duplicated.");
    }
    if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new BrokerProtocolError("Output artifact name is invalid.");
    }
    if (stream !== "stdout" && stream !== "stderr") throw new BrokerProtocolError("Output artifact stream is invalid.");
    if (seenStreams.has(stream)) throw new BrokerProtocolError("Output artifact stream is duplicated.");
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new BrokerProtocolError("Output artifact sha256 is invalid.");
    if (value.redacted !== true) throw new BrokerProtocolError("Output artifact must be broker-redacted.");
    seen.add(artifactId);
    seenStreams.add(stream);
    return {
      artifactId,
      name,
      stream,
      path: stringValue(value.path, "Output artifact path"),
      sha256,
      sizeBytes: integerValue(value.sizeBytes, "Output artifact sizeBytes"),
      complete: booleanValue(value.complete, "Output artifact complete"),
      redacted: true,
      redactionLossy: booleanValue(value.redactionLossy, "Output artifact redactionLossy")
    };
  });
}

function processState(input: unknown): Exclude<ProcessState, "lost"> {
  if (input === "running" || input === "exited" || input === "terminated") return input;
  throw new BrokerProtocolError(`Invalid process state '${String(input)}'.`);
}

export function parseHello(input: unknown): { instanceId: string; artifactRoot?: string } {
  const value = protocolRecord(input, "Broker hello result");
  if (value.protocolVersion !== BROKER_PROTOCOL_VERSION) throw new BrokerProtocolError("Broker hello version mismatch.");
  const instanceId = stringValue(value.instanceId, "Broker instanceId");
  if (instanceId.length === 0) throw new BrokerProtocolError("Broker instanceId cannot be empty.");
  if (value.artifactRoot !== undefined && typeof value.artifactRoot !== "string") {
    throw new BrokerProtocolError("Broker artifactRoot must be a string when present.");
  }
  return {
    instanceId,
    ...(typeof value.artifactRoot === "string" ? { artifactRoot: value.artifactRoot } : {})
  };
}

export { parseDoctor } from "./broker-doctor-values.js";

export function parseHandleId(input: unknown): string {
  const id = stringValue(protocolRecord(input, "Process spawn result").handleId, "Process handleId");
  if (id.length === 0) throw new BrokerProtocolError("Process handleId cannot be empty.");
  return id;
}

export function parseSpawnedProcess(input: unknown): { id: string; systemProcessId?: number } {
  const value = protocolRecord(input, "Process spawn result");
  const id = parseHandleId(value);
  const processId = value.processId;
  if (processId !== undefined && (!Number.isSafeInteger(processId) || (processId as number) <= 0)) {
    throw new BrokerProtocolError("Process processId must be a positive integer when present.");
  }
  return { id, ...(processId === undefined ? {} : { systemProcessId: processId as number }) };
}

export function parseProcessHandoff(input: unknown): { handoffId: string; systemProcessId?: number } {
  const value = protocolRecord(input, "Process handoff result");
  const handoffId = stringValue(value.handoffId, "Process handoffId");
  if (!handoffId) throw new BrokerProtocolError("Process handoffId cannot be empty.");
  const processId = value.processId;
  if (processId !== undefined && (!Number.isSafeInteger(processId) || (processId as number) <= 0)) {
    throw new BrokerProtocolError("Process handoff processId must be a positive integer when present.");
  }
  return { handoffId, ...(processId === undefined ? {} : { systemProcessId: processId as number }) };
}

export function parseProcessValue(input: unknown): ProcessValue {
  const value = protocolRecord(input, "Process result");
  const artifacts = outputArtifacts(value.outputArtifacts);
  const failure = processLaunchFailure(value.failure);
  const state = processState(value.state);
  if (state === "running" && artifacts.length > 0) {
    throw new BrokerProtocolError("Running processes cannot publish final output artifacts.");
  }
  if (state === "running" && failure) {
    throw new BrokerProtocolError("Running processes cannot publish a launch failure.");
  }
  return {
    state,
    exitCode: nullableExitCode(value.exitCode),
    signal: nullableString(value.signal, "Process signal"),
    durationMs: integerValue(value.durationMs, "Process durationMs"),
    stdout: outputChunk(value.stdout, "Process stdout"),
    stderr: outputChunk(value.stderr, "Process stderr"),
    outputArtifacts: artifacts,
    ...(failure ? { failure } : {})
  };
}

export function parseExecutionValue(input: unknown): ExecutionValue {
  const value = protocolRecord(input, "Execution result");
  const process = parseProcessValue(value);
  if (process.state === "running") {
    throw new BrokerProtocolError("Foreground execution must have a terminal broker state.");
  }
  return {
    ...process,
    state: process.state,
    timedOut: booleanValue(value.timedOut, "Execution timedOut"),
    idleTimedOut: booleanValue(value.idleTimedOut, "Execution idleTimedOut"),
    cancelled: booleanValue(value.cancelled, "Execution cancelled")
  };
}
