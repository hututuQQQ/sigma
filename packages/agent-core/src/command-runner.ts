import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

export type CommandSettledOn = "close" | "exit-drain" | "timeout" | "error";

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  settledOn: CommandSettledOn;
  error?: Error;
}

export type BashCommandResult = CommandResult;

export interface RunCommandOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  timeoutMs: number;
  drainMs?: number;
  killSettleMs?: number;
  termToKillMs?: number;
  detachedProcessGroup?: boolean;
  windowsHide?: boolean;
}

export interface RunBashCommandOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  drainMs?: number;
  killSettleMs?: number;
  termToKillMs?: number;
  detachedProcessGroup?: boolean;
}

export function bashExecutable(): string {
  if (process.env.AGENT_BASH_PATH) {
    return process.env.AGENT_BASH_PATH;
  }

  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe"
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }

  return "bash";
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) clearTimeout(timer);
}

function killWindowsProcessTree(pid: number): void {
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true
  });
  killer.on("error", () => {
    // Fall back to child.kill below when taskkill is unavailable.
  });
  killer.unref();
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    killWindowsProcessTree(child.pid);
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the shell below.
    }
  }
  child.kill(signal);
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const drainMs = Math.max(0, Math.floor(options.drainMs ?? 200));
  const killSettleMs = Math.max(1, Math.floor(options.killSettleMs ?? 1000));
  const termToKillMs = Math.max(1, Math.min(killSettleMs, Math.floor(options.termToKillMs ?? 500)));
  const detachedProcessGroup = options.detachedProcessGroup ?? process.platform !== "win32";

  return await new Promise<CommandResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | string | null = null;
    let sentSignal: NodeJS.Signals | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let hardSettleTimer: ReturnType<typeof setTimeout> | undefined;

    function finish(settledOn: CommandSettledOn, error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimer(timeoutTimer);
      clearTimer(drainTimer);
      clearTimer(escalationTimer);
      clearTimer(hardSettleTimer);

      if (child) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }

      resolve({
        exitCode,
        signal: exitSignal ?? sentSignal,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        durationMs: Date.now() - startedAt,
        timedOut,
        settledOn,
        error
      });
    }

    function scheduleDrain(): void {
      if (settled) return;
      clearTimer(drainTimer);
      drainTimer = setTimeout(() => finish("exit-drain"), drainMs);
      drainTimer.unref();
    }

    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: detachedProcessGroup,
        windowsHide: options.windowsHide ?? true
      });
    } catch (error) {
      finish("error", error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const runningChild = child;
    runningChild.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    runningChild.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    runningChild.stdin.on("error", () => {
      // The process may exit before it consumes stdin.
    });
    runningChild.stdin.end(options.stdin);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      sentSignal = "SIGTERM";
      killProcessTree(runningChild, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (settled) return;
        sentSignal = "SIGKILL";
        killProcessTree(runningChild, "SIGKILL");
      }, termToKillMs);
      escalationTimer.unref();

      hardSettleTimer = setTimeout(() => finish("timeout"), killSettleMs);
      hardSettleTimer.unref();
    }, Math.max(1, Math.floor(options.timeoutMs)));
    timeoutTimer.unref();

    runningChild.on("error", (error) => {
      finish("error", error);
    });

    runningChild.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      clearTimer(timeoutTimer);
      scheduleDrain();
    });

    runningChild.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish("close");
    });
  });
}

export async function runBashCommand(options: RunBashCommandOptions): Promise<BashCommandResult> {
  return await runCommand({
    command: bashExecutable(),
    args: ["-lc", options.command],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    drainMs: options.drainMs,
    killSettleMs: options.killSettleMs,
    termToKillMs: options.termToKillMs,
    detachedProcessGroup: options.detachedProcessGroup,
    windowsHide: true
  });
}
