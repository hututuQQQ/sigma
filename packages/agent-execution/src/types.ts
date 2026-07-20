export const BROKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type NetworkPolicy = "none" | "loopback" | "full";
export type SandboxMode = "required";
export type ContainerEngine = "auto" | "docker" | "podman";
export type ResolvedContainerEngine = Exclude<ContainerEngine, "auto">;
export type ContainerTarget = "owned" | "managed";
export type ProcessState = "running" | "exited" | "terminated" | "lost";
export type ProcessLifecycle = "session" | "deliverable";

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
  /** Read/execute-only roots for explicitly trusted absolute executables. */
  executionRoots?: string[];
  protectedPaths?: string[];
  /** Trusted validation adapter request: mount a broker-owned writable copy at
   * this exact in-sandbox path and discard it when the process exits. */
  disposableWorkspaceRoot?: string;
  /** Explicit fallback for targets without same-path COW. The broker executes
   * at the real path with read-only workspace access and writable scratch. */
  readOnlyValidationWorkspaceRoot?: string;
  /** One-use broker-issued capability. Its topology fields are observational;
   * the native broker authorizes only the stored lease id. */
  repositoryMetadataLease?: RepositoryMetadataLeaseV1;
  /** Runtime-only broker capability. Tool/model arguments cannot construct or
   * select its host paths or lease id. */
  scratchLease?: ScratchLeaseV1;
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
  /** Deliverable processes may be explicitly handed to the outer environment. */
  lifecycle?: ProcessLifecycle;
}

export interface ProcessHandle {
  id: string;
  brokerInstanceId: string;
  systemProcessId?: number;
  lifecycle?: ProcessLifecycle;
}

export interface ProcessHandoffResult {
  handle: ProcessHandle;
  handoffId: string;
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
  /** Authenticated native launch failure, when the sandbox launcher never reached the user process. */
  failure?: ProcessLaunchFailureV1;
}

export interface ProcessLaunchFailureV1 {
  phase: "sandbox_launch";
  code: string;
  message: string;
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
  lease?: {
    protocolVersion: 1;
    readStrategy: "persistent_workspace_root";
    writerStrategy: "root_lease_checkpointed";
    recoveryJournal: "writes_only";
  };
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
  processHandoff?: boolean;
  networkModes: NetworkPolicy[];
  /** The broker enforces read/execute-only roots independently from workspace roots. */
  executionRoots?: boolean;
  /** Shells listed here have passed the native sandbox self-test. */
  shells?: BrokerVerifiedShell[];
  /** Bare executables proved present in the execution target for this connection. */
  runtimeCommands?: string[];
  /** True only when omission proves unavailability in this connection's bounded
   * executable namespace (the target-PATH probe for OCI, the manifest allowlist for native). */
  runtimeCommandSnapshotComplete?: boolean;
  /** Absolute PATH entries observed by the broker process. OCI clients use
   * this connection-bound value instead of inheriting the control process's
   * PATH when the target resolves a bare executable name. */
  executableSearchPaths?: string[];
}

export interface BrokerVerifiedShell {
  kind: "powershell" | "cmd" | "bash";
  executable: string;
  verified: true;
  /** The sandbox has proved that the shell can launch separately trusted executables. */
  supportsChildProcesses?: boolean;
}

export interface BrokerDoctorReport {
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  brokerVersion: string;
  platform: string;
  architecture: string;
  sandbox: BrokerSandboxReport;
  capabilities: BrokerCapabilities;
  /** OCI availability, or the authenticated identity when this is an OCI broker. */
  container?: BrokerContainerReport;
}

/** Authenticated OCI identity returned by the broker. A report is diagnostic;
 * the broker must independently re-attest the target before every launch. */
export interface BrokerContainerReport {
  available: boolean;
  backend: "oci";
  engine?: ResolvedContainerEngine;
  target?: ContainerTarget;
  targetId?: string;
  targetStartedAt?: string;
  imageId?: string;
  imageDigest?: string;
  helperDigest?: string;
  attestationDigest?: string;
  reason?: string;
}

export interface ContainerExecutionConfig {
  engine: ContainerEngine;
  target: ContainerTarget;
  /** Maximum network capability granted to the target container. */
  network?: NetworkPolicy;
  /** Immutable digest reference. Required for an owned target. */
  image?: string;
}

/** Launcher-owned proof. It is deliberately absent from CLI/config types so a
 * workspace, model, or evaluator cannot select a managed engine target. */
export interface TrustedManagedContainerAttestationV1 {
  protocolVersion: 1;
  engine: ResolvedContainerEngine;
  selector: string;
  targetId: string;
  targetStartedAt: string;
  imageId: string;
  imageDigest?: string;
  labelsDigest: string;
  /** Digest of the exact root-owned, read-only helper tree executed in the managed target. */
  helperDigest: string;
  attestationDigest: string;
}

export interface TrustedContainerBrokerRequest {
  workspace: string;
  config: ContainerExecutionConfig;
  managedAttestation?: TrustedManagedContainerAttestationV1;
}

/** Product/launcher dependency only. Never construct this value from CLI,
 * environment, workspace configuration, task metadata, or model output. */
export interface TrustedContainerLauncherV1 {
  protocolVersion: 1;
  managedAttestation?: TrustedManagedContainerAttestationV1;
  createBroker(request: TrustedContainerBrokerRequest): ExecutionBroker;
}

export interface BrokerSandboxLeaseStatus {
  leaseId: string;
  workspaceIdentity: string;
  generation: number;
  principalId: string;
  access: "read" | "write";
  roots: string[];
  state: "preparing" | "active" | "revoking" | "retired" | "tainted";
}

export interface BrokerSandboxRevokeResult {
  revoked: boolean;
  retiredPrincipalId: string;
  generation: number;
}

export interface RepositoryMetadataLeaseRequestV1 {
  protocolVersion: 1;
  repositoryRoot: string;
  gitDir: string;
  commonDir: string;
  executable: string;
  network: "none";
}

export interface RepositoryMetadataLeaseV1 extends RepositoryMetadataLeaseRequestV1 {
  leaseId: string;
  /** SHA-256 of the exact executable object pinned when the broker issued the lease. */
  executableSha256: string;
  /** Capabilities are deliberately single-use and are burned before launch. */
  uses: 1;
}

/**
 * A package-verified runtime/toolchain that may execute inside the sandbox.
 * The broker treats every entry as trusted configuration, never as model- or
 * command-provided input.
 */
export interface TrustedToolchainManifestEntry {
  /** Stable manifest identifier, for example "bundled-node". */
  id: string;
  /** Runtime family. Node aliases are also detected independently. */
  runtime?: "node" | "generic";
  /** Verified absolute entry-point executable. */
  executable: string;
  /** Command aliases that higher layers may resolve to executable. */
  aliases?: string[];
  /** Trusted argument prefixes keyed by alias. This lets a packaged runtime
   * expose script-backed entry points (for example npm/pnpm through Node)
   * without trusting shell shims or asking the model for host paths. */
  aliasArguments?: Record<string, string[]>;
  /** Read/execute roots; defaults to the exact executable. */
  executionRoots?: string[];
  /** Read-only runtime dependency roots mounted only when this exact entry
   * point is invoked. These roots never authorize another executable. */
  runtimeRoots?: string[];
  /** Directories prepended to PATH; defaults to none. */
  pathEntries?: string[];
  /** Immutable environment required by this runtime and inherited by descendants. */
  environment?: Record<string, string>;
  /** Supply-chain proof required for Node in a required Windows sandbox. */
  compatibility?: WindowsAppContainerNodeCompatibilityProof;
}

export interface WindowsAppContainerNodeCompatibilityProof {
  kind: "windows_appcontainer_node";
  patchId: string;
  sourceSha256: string;
  normalizedContentSha256: string;
  /** Full-file digest captured for this exact signed or unsigned executable. */
  executableSha256: string;
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
  repairSandbox?(signal?: AbortSignal): Promise<BrokerDoctorReport>;
  sandboxLeaseStatus?(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxLeaseStatus>;
  revokeSandboxLease?(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxRevokeResult>;
  acquireRepositoryMetadataLease?(
    request: RepositoryMetadataLeaseRequestV1,
    options?: BrokerRequestOptions
  ): Promise<RepositoryMetadataLeaseV1>;
  acquireScratchLease?(
    request: ScratchLeaseRequestV1,
    options?: BrokerRequestOptions
  ): Promise<ScratchLeaseV1>;
  /** Idempotently ends a RuntimeSession lease after all of its processes have
   * reached a terminal state. */
  releaseScratchLease?(sessionId: string, options?: BrokerRequestOptions): Promise<void>;
  execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult>;
  spawn(request: ProcessSpawnRequest, options?: BrokerRequestOptions): Promise<ProcessHandle>;
  poll(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult>;
  write(handle: ProcessHandle, data: string, options?: BrokerRequestOptions): Promise<void>;
  terminate(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult>;
  handoff?(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessHandoffResult>;
  /** Acknowledge broker spool files only after their bytes reached durable CAS or were intentionally discarded. */
  releaseOutputArtifacts?(artifactIds: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface SigmaExecBrokerClientOptions {
  /** Exactly one transport is required. socketPath/trustedStream are trusted
   * product boundaries and must never come from model/workspace configuration. */
  helperPath?: string;
  socketPath?: string;
  trustedStream?: Duplex;
  helperArgs?: string[];
  /** Additional fixed parent for shared broker output artifacts. */
  artifactRootParent?: string;
  executionBackend?: "native" | "oci";
  sandboxMode?: SandboxMode;
  requestTimeoutMs?: number;
  /** Deadline for startup doctor/recovery and explicit sandbox setup. */
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  /** Time allowed for an exec cancellation to return its terminal response.
   * On expiry the broker is closed and its process tree must exit before the
   * request rejects. */
  cancellationGraceMs?: number;
  maximumFrameBytes?: number;
  maximumStderrBytes?: number;
  secrets?: Record<string, string | undefined>;
  /**
   * Package-verified toolchains made available read/execute-only to sandboxed
   * commands. Omission trusts no runtime implicitly; product composition roots
   * must bind their verified bundled executable explicitly.
   */
  trustedToolchains?: TrustedToolchainManifestEntry[];
}
import type { Duplex } from "node:stream";
import type { ScratchLeaseRequestV1, ScratchLeaseV1 } from "./scratch-lease-types.js";
export type { ScratchLeaseRequestV1, ScratchLeaseV1 } from "./scratch-lease-types.js";
