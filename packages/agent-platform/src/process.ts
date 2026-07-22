import path from "node:path";
import type {
  BrokerRequestOptions,
  ExecutionRequest,
  ExecutionResult,
  ManagedSessionBindingRequestV1,
  ManagedSessionBindingV1,
  ProcessLaunchFailureV1,
  ProcessHandle,
  ProcessHandoffResult,
  ProcessPollResult
} from "agent-execution";
import { BrokerCancelledError } from "agent-execution";
import type { ShellKind } from "./environment.js";

export interface ProcessExecutionPort {
  readonly lostProcessHandles?: readonly ProcessHandle[];
  execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult>;
  terminate?(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult>;
  handoff?(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessHandoffResult>;
  releaseOutputArtifacts?(artifactIds: string[]): Promise<void>;
  /** Idempotently releases broker-owned scratch after every session process has settled. */
  releaseScratchLease?(sessionId: string, options?: BrokerRequestOptions): Promise<void>;
  bindManagedSession?(
    request: ManagedSessionBindingRequestV1,
    options?: BrokerRequestOptions
  ): Promise<ManagedSessionBindingV1>;
}

export interface ProcessRequest {
  execution: ProcessExecutionPort;
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  maxStdoutLines?: number;
  signal: AbortSignal;
  readRoots?: string[];
  writeRoots?: string[];
  protectedPaths?: string[];
  network?: "none" | "full";
  networkApproved?: boolean;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutLimitReached: boolean;
  outputTruncated: boolean;
  /** Authenticated sandbox launch failure when the user process never started. */
  failure?: ProcessLaunchFailureV1;
}

export class ProcessExecutionUnavailableError extends Error {
  readonly code = "sandbox_unavailable";

  constructor() {
    super("Process execution requires an explicitly injected sandbox execution port.");
    this.name = "ProcessExecutionUnavailableError";
  }
}

function limitedLines(value: string, maximum: number | undefined): { value: string; limited: boolean } {
  if (maximum === undefined) return { value, limited: false };
  let lines = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") continue;
    lines += 1;
    if (lines === maximum && index + 1 < value.length) {
      return { value: value.slice(0, index + 1), limited: true };
    }
  }
  return { value, limited: false };
}

function executionRequest(request: ProcessRequest): ExecutionRequest {
  const cwd = path.resolve(request.cwd);
  const readRoots = (request.readRoots ?? [cwd]).map((root) => path.resolve(root));
  const writeRoots = (request.writeRoots ?? []).map((root) => path.resolve(root));
  const network = request.network ?? "none";
  return {
    command: {
      executable: request.executable,
      args: request.args,
      cwd,
      ...(request.env ? { environment: { overrides: request.env } } : {})
    },
    policy: {
      sandbox: "required",
      network,
      networkApproved: network === "full" && request.networkApproved === true,
      readRoots,
      writeRoots,
      protectedPaths: request.protectedPaths ?? [path.join(cwd, ".git"), path.join(cwd, ".agent")]
    },
    timeoutMs: request.timeoutMs,
    idleTimeoutMs: request.idleTimeoutMs,
    maxOutputBytes: request.maxOutputBytes
  };
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  request.signal.throwIfAborted();
  if (!request.execution) throw new ProcessExecutionUnavailableError();
  const startedAt = performance.now();
  let result: ExecutionResult;
  try {
    result = await request.execution.execute(executionRequest(request), { signal: request.signal });
  } catch (error) {
    const cancelled = error instanceof BrokerCancelledError
      || (error !== null && typeof error === "object"
        && (error as { code?: unknown }).code === "broker_cancelled");
    if (!cancelled) throw error;
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      durationMs: Math.max(0, performance.now() - startedAt),
      stdoutLimitReached: false,
      outputTruncated: false
    };
  }
  const artifactIds = result.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
  if (artifactIds.length > 0) {
    await request.execution.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
  }
  const stdout = limitedLines(result.stdout, request.maxStdoutLines);
  return {
    exitCode: result.exitCode,
    stdout: stdout.value,
    stderr: result.stderr,
    timedOut: result.timedOut || result.idleTimedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
    stdoutLimitReached: stdout.limited,
    outputTruncated: result.outputTruncated || stdout.limited,
    ...(result.failure ? { failure: result.failure } : {})
  };
}

const POWERSHELL_UTF8_PREFIX = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;";

export function normalizeWindowsShellInvocation(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): { executable: string; args: string[] } {
  const normalized = [...args];
  if (platform !== "win32") return { executable, args: normalized };
  const name = path.win32.basename(executable).toLowerCase();
  if (name === "cmd" || name === "cmd.exe") {
    const commandIndex = normalized.findIndex((item) => /^\/(?:c|k)$/iu.test(item));
    const valueIndex = commandIndex + 1;
    if (commandIndex >= 0 && normalized[valueIndex]
      && !/^\s*chcp\s+65001(?:\s*>\s*nul)?\s*&/iu.test(normalized[valueIndex]!)) {
      normalized[valueIndex] = `chcp 65001>nul & ${normalized[valueIndex]}`;
    }
  } else if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name)) {
    const commandIndex = normalized.findIndex((item) => /^-(?:command|c)$/iu.test(item));
    const valueIndex = commandIndex + 1;
    if (commandIndex >= 0 && normalized[valueIndex]
      && !normalized[valueIndex]!.startsWith(POWERSHELL_UTF8_PREFIX)) {
      normalized[valueIndex] = `${POWERSHELL_UTF8_PREFIX}${normalized[valueIndex]}`;
    }
  }
  return { executable, args: normalized };
}

export function shellInvocation(shell: ShellKind, command: string): { executable: string; args: string[] } {
  if (shell === "powershell") {
    return normalizeWindowsShellInvocation(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    );
  }
  if (shell === "cmd") return normalizeWindowsShellInvocation("cmd.exe", ["/d", "/s", "/c", command]);
  return { executable: "bash", args: ["-lc", command] };
}

export async function runShell(
  shell: ShellKind,
  command: string,
  options: Omit<ProcessRequest, "executable" | "args">
): Promise<ProcessResult> {
  return await runProcess({ ...options, ...shellInvocation(shell, command) });
}
