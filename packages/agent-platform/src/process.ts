import path from "node:path";
import type {
  BrokerRequestOptions,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult
} from "agent-execution";
import type { ShellKind } from "./environment.js";

export interface ProcessExecutionPort {
  readonly lostProcessHandles?: readonly ProcessHandle[];
  execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult>;
  terminate?(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult>;
  releaseOutputArtifacts?(artifactIds: string[]): Promise<void>;
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
  const result = await request.execution.execute(executionRequest(request), { signal: request.signal });
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
    outputTruncated: result.outputTruncated || stdout.limited
  };
}

export function shellInvocation(shell: ShellKind, command: string): { executable: string; args: string[] } {
  if (shell === "powershell") {
    return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  if (shell === "cmd") return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { executable: "bash", args: ["-lc", command] };
}

export async function runShell(
  shell: ShellKind,
  command: string,
  options: Omit<ProcessRequest, "executable" | "args">
): Promise<ProcessResult> {
  return await runProcess({ ...options, ...shellInvocation(shell, command) });
}
