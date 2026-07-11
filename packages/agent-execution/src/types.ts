export const BROKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type NetworkPolicy = "none" | "full";
export type SandboxMode = "required" | "unsafe";
export type ProcessState = "running" | "exited" | "terminated" | "lost";

export interface EnvironmentRequest {
  /** Safe host variables to copy in addition to the platform baseline. */
  passthrough?: string[];
  /** Explicit non-secret values. Secret-looking keys are rejected. */
  overrides?: Record<string, string>;
}

export interface CommandSpec {
  executable: string;
  args?: string[];
  cwd: string;
  environment?: EnvironmentRequest;
  stdin?: string;
}

export interface ExecutionPolicy {
  sandbox: SandboxMode;
  network: NetworkPolicy;
  networkApproved?: boolean;
  readRoots: string[];
  writeRoots: string[];
  protectedPaths?: string[];
  unsafeHostExecApproved?: boolean;
}

export interface ExecutionRequest {
  command: CommandSpec;
  policy: ExecutionPolicy;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessSpawnRequest {
  command: CommandSpec;
  policy: ExecutionPolicy;
  maxOutputBytes?: number;
  /** Keep redacted stdout byte lengths stable for framed protocols such as LSP. */
  outputRedaction?: "default" | "length_preserving" | "framed_jsonrpc";
  pty?: boolean;
  ptyColumns?: number;
  ptyRows?: number;
}

export interface ProcessHandle {
  id: string;
  brokerInstanceId: string;
  systemProcessId?: number;
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  outputTruncated: boolean;
  /** Full redacted output captured when the bounded tail overflowed. */
  outputArtifacts?: ProcessOutputArtifact[];
}

export interface ProcessOutputArtifact {
  brokerArtifactId: string;
  name: string;
  stream: "stdout" | "stderr";
  brokerSha256: string;
  sizeBytes: number;
  complete: boolean;
  redactionLossy: boolean;
  content: Uint8Array;
}

export interface ProcessPollResult extends ProcessOutput {
  handle: ProcessHandle;
  state: ProcessState;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export interface ExecutionResult extends ProcessOutput {
  state: Exclude<ProcessState, "running" | "lost">;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  idleTimedOut: boolean;
  cancelled: boolean;
}

export interface BrokerSandboxReport {
  available: boolean;
  backend: string;
  selfTestPassed: boolean;
  setupRequired: boolean;
  reason?: string;
  hardening?: {
    landlockAbi?: number;
    noNewPrivileges: boolean;
    seccompFilter: boolean;
    lessPrivilegedAppContainer: boolean;
    mountNamespace: boolean;
    pidNamespace: boolean;
    networkNamespace: boolean;
  };
}

export interface BrokerCapabilities {
  foreground: boolean;
  background: boolean;
  stdin: boolean;
  pty: boolean;
  networkModes: NetworkPolicy[];
}

export interface BrokerDoctorReport {
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  brokerVersion: string;
  platform: string;
  architecture: string;
  sandbox: BrokerSandboxReport;
  capabilities: BrokerCapabilities;
}

export interface BrokerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExecutionBroker {
  readonly lostProcessHandles: readonly ProcessHandle[];
  connect(signal?: AbortSignal): Promise<BrokerDoctorReport>;
  doctor(signal?: AbortSignal): Promise<BrokerDoctorReport>;
  /** Performs the broker's controlled, platform-specific one-time preparation. */
  setupSandbox?(signal?: AbortSignal): Promise<BrokerDoctorReport>;
  execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult>;
  spawn(request: ProcessSpawnRequest, options?: BrokerRequestOptions): Promise<ProcessHandle>;
  poll(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult>;
  write(handle: ProcessHandle, data: string, options?: BrokerRequestOptions): Promise<void>;
  terminate(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult>;
  /** Acknowledge broker spool files only after their bytes reached durable CAS or were intentionally discarded. */
  releaseOutputArtifacts?(artifactIds: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface SigmaExecBrokerClientOptions {
  helperPath: string;
  helperArgs?: string[];
  sandboxMode?: SandboxMode;
  allowUnsafeHostExec?: boolean;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  maximumFrameBytes?: number;
  maximumStderrBytes?: number;
  secrets?: Record<string, string | undefined>;
}
