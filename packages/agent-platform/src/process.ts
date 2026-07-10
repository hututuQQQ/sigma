import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ShellKind } from "./environment.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  maxStdoutLines?: number;
  signal: AbortSignal;
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

function boundedAppend(current: string, chunk: string, maximum: number): string {
  const next = `${current}${chunk}`;
  return next.length <= maximum ? next : `[truncated ${next.length - maximum} chars]\n${next.slice(-maximum)}`;
}

class ProcessOutputCapture {
  stdout = "";
  stderr = "";
  stdoutLimitReached = false;
  outputTruncated = false;
  private stdoutPending = "";
  private stdoutLines = 0;

  constructor(private readonly maximum: number, private readonly lineLimit?: number) {}

  appendStdout(value: string): boolean {
    if (this.lineLimit === undefined) {
      this.append("stdout", value);
      return false;
    }
    this.stdoutPending += value;
    while (this.stdoutLines < this.lineLimit) {
      const newline = this.stdoutPending.indexOf("\n");
      if (newline < 0) break;
      this.append("stdout", this.stdoutPending.slice(0, newline + 1));
      this.stdoutPending = this.stdoutPending.slice(newline + 1);
      this.stdoutLines += 1;
    }
    if (this.stdoutLines < this.lineLimit) return false;
    this.stdoutPending = "";
    this.stdoutLimitReached = true;
    return true;
  }

  appendStderr(value: string): void { this.append("stderr", value); }

  finish(): void {
    if (this.lineLimit !== undefined && this.stdoutPending && this.stdoutLines < this.lineLimit) {
      this.append("stdout", this.stdoutPending);
      this.stdoutPending = "";
    }
  }

  private append(stream: "stdout" | "stderr", value: string): void {
    if (this[stream].length + value.length > this.maximum) this.outputTruncated = true;
    this[stream] = boundedAppend(this[stream], value, this.maximum);
  }
}

export function terminateProcessTree(child: ChildProcess, force = false): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.on("error", () => { child.kill(); });
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal.aborted) throw request.signal.reason ?? new Error("Process cancelled.");
  const startedAt = Date.now();
  const maxOutput = request.maxOutputBytes ?? 1_000_000;
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: path.resolve(request.cwd),
      env: { ...process.env, ...request.env },
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = new ProcessOutputCapture(maxOutput, request.maxStdoutLines);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", onAbort);
      output.finish();
      resolve({
        exitCode, stdout: output.stdout, stderr: output.stderr, timedOut, cancelled,
        durationMs: Date.now() - startedAt,
        stdoutLimitReached: output.stdoutLimitReached, outputTruncated: output.outputTruncated
      });
    };
    const terminate = (): void => {
      if (child.exitCode !== null) return;
      terminateProcessTree(child);
      setTimeout(() => terminateProcessTree(child, true), 750).unref();
    };
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timer.unref();
    const onIdle = (): void => {
      timedOut = true;
      terminate();
    };
    let idleTimer = request.idleTimeoutMs ? setTimeout(onIdle, request.idleTimeoutMs) : undefined;
    idleTimer?.unref();
    const heartbeat = (): void => {
      if (!idleTimer || !request.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, request.idleTimeoutMs);
      idleTimer.unref();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      heartbeat();
      if (output.appendStdout(chunk.toString("utf8"))) terminate();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      heartbeat();
      output.appendStderr(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
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
