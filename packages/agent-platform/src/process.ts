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
  signal: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

function boundedAppend(current: string, chunk: string, maximum: number): string {
  const next = `${current}${chunk}`;
  return next.length <= maximum ? next : `[truncated ${next.length - maximum} chars]\n${next.slice(-maximum)}`;
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
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - startedAt });
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
    child.stdout.on("data", (chunk: Buffer) => { heartbeat(); stdout = boundedAppend(stdout, chunk.toString("utf8"), maxOutput); });
    child.stderr.on("data", (chunk: Buffer) => { heartbeat(); stderr = boundedAppend(stderr, chunk.toString("utf8"), maxOutput); });
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
