import { BrokerProtocolError } from "./errors.js";
import { protocolRecord } from "./protocol.js";
import { BROKER_PROTOCOL_VERSION, type BrokerDoctorReport, type ProcessState } from "./types.js";

export interface OutputChunkValue {
  data: string;
  nextOffset: number;
  droppedBytes: number;
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
}

export interface ExecutionValue extends ProcessValue {
  state: "exited" | "terminated";
  timedOut: boolean;
  idleTimedOut: boolean;
  cancelled: boolean;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new BrokerProtocolError(`${label} must be a string.`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new BrokerProtocolError(`${label} must be boolean.`);
  return value;
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

function outputChunk(input: unknown, label: string): OutputChunkValue {
  const value = protocolRecord(input, label);
  return {
    data: stringValue(value.data, `${label}.data`),
    nextOffset: integerValue(value.nextOffset, `${label}.nextOffset`),
    droppedBytes: integerValue(value.droppedBytes, `${label}.droppedBytes`)
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

export function parseDoctor(input: unknown): BrokerDoctorReport {
  const value = protocolRecord(input, "Broker doctor result");
  if (value.protocolVersion !== BROKER_PROTOCOL_VERSION) throw new BrokerProtocolError("Broker doctor version mismatch.");
  const sandbox = protocolRecord(value.sandbox, "Broker sandbox report");
  const capabilities = protocolRecord(value.capabilities, "Broker capabilities");
  const hardening = sandbox.hardening === undefined
    ? undefined : protocolRecord(sandbox.hardening, "Broker sandbox hardening");
  const landlockAbi = hardening?.landlockAbi;
  if (landlockAbi !== undefined && landlockAbi !== null
    && (!Number.isSafeInteger(landlockAbi) || Number(landlockAbi) < 1)) {
    throw new BrokerProtocolError("Broker Landlock ABI is invalid.");
  }
  const networkModes = capabilities.networkModes;
  if (!Array.isArray(networkModes) || networkModes.some((mode) => mode !== "none" && mode !== "full")) {
    throw new BrokerProtocolError("Broker networkModes are invalid.");
  }
  return {
    protocolVersion: BROKER_PROTOCOL_VERSION,
    brokerVersion: stringValue(value.brokerVersion, "Broker version"),
    platform: stringValue(value.platform, "Broker platform"),
    architecture: stringValue(value.architecture, "Broker architecture"),
    sandbox: {
      available: booleanValue(sandbox.available, "sandbox.available"),
      backend: stringValue(sandbox.backend, "sandbox.backend"),
      selfTestPassed: booleanValue(sandbox.selfTestPassed, "sandbox.selfTestPassed"),
      setupRequired: booleanValue(sandbox.setupRequired, "sandbox.setupRequired"),
      ...(typeof sandbox.reason === "string" ? { reason: sandbox.reason } : {}),
      ...(hardening ? { hardening: {
        ...(typeof landlockAbi === "number" ? { landlockAbi } : {}),
        noNewPrivileges: booleanValue(hardening.noNewPrivileges, "sandbox.hardening.noNewPrivileges"),
        seccompFilter: booleanValue(hardening.seccompFilter, "sandbox.hardening.seccompFilter"),
        lessPrivilegedAppContainer: booleanValue(
          hardening.lessPrivilegedAppContainer,
          "sandbox.hardening.lessPrivilegedAppContainer"
        )
      } } : {})
    },
    capabilities: {
      foreground: booleanValue(capabilities.foreground, "capabilities.foreground"),
      background: booleanValue(capabilities.background, "capabilities.background"),
      stdin: booleanValue(capabilities.stdin, "capabilities.stdin"),
      pty: booleanValue(capabilities.pty, "capabilities.pty"),
      networkModes: networkModes as Array<"none" | "full">
    }
  };
}

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

export function parseProcessValue(input: unknown): ProcessValue {
  const value = protocolRecord(input, "Process result");
  const artifacts = outputArtifacts(value.outputArtifacts);
  const state = processState(value.state);
  if (state === "running" && artifacts.length > 0) {
    throw new BrokerProtocolError("Running processes cannot publish final output artifacts.");
  }
  return {
    state,
    exitCode: nullableExitCode(value.exitCode),
    signal: nullableString(value.signal, "Process signal"),
    durationMs: integerValue(value.durationMs, "Process durationMs"),
    stdout: outputChunk(value.stdout, "Process stdout"),
    stderr: outputChunk(value.stderr, "Process stderr"),
    outputArtifacts: artifacts
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
