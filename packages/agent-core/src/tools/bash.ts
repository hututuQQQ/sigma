import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { isProbablyMutatingCommand, resolveWorkspacePath } from "../policy.js";

interface BashArgs {
  command?: unknown;
  cwd?: unknown;
  timeoutSec?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatOutput(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean): string {
  const parts = [`exitCode: ${exitCode === null ? "null" : exitCode}`];
  if (timedOut) parts.push("timedOut: true");
  parts.push("stdout:");
  parts.push(stdout);
  parts.push("stderr:");
  parts.push(stderr);
  return parts.join("\n");
}

function bashExecutable(): string {
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

export async function executeBashTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as BashArgs;
  const command = typeof parsed.command === "string" ? parsed.command : "";
  if (!command.trim()) {
    return { ok: false, content: "bash requires a non-empty command string" };
  }

  if (context.permissionMode === "ask" && isProbablyMutatingCommand(command)) {
    return {
      ok: false,
      content: "Permission mode 'ask' is non-interactive in this MVP; mutating bash commands are rejected."
    };
  }

  let cwd: string;
  try {
    cwd = typeof parsed.cwd === "string" ? resolveWorkspacePath(context.workspacePath, parsed.cwd) : context.workspacePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  const timeoutSec = asNumber(parsed.timeoutSec) ?? context.commandTimeoutSec;
  const timeoutMs = Math.max(1, Math.floor(timeoutSec * 1000));
  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;

  return await new Promise<ToolResult>((resolve) => {
    const child = spawn(bashExecutable(), ["-lc", command], {
      cwd,
      env: process.env,
      windowsHide: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        content: `Failed to start bash: ${error.message}`,
        metadata: {
          durationMs: Date.now() - startedAt,
          truncated: false
        }
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      const content = formatOutput(exitCode, stdoutBuffer.toString("utf8"), stderrBuffer.toString("utf8"), timedOut);
      const truncated = truncateMiddle(content, context.maxToolOutputChars);
      resolve({
        ok: !timedOut && exitCode === 0,
        content: truncated.text,
        metadata: {
          exitCode,
          durationMs: Date.now() - startedAt,
          stdoutBytes: stdoutBuffer.byteLength,
          stderrBytes: stderrBuffer.byteLength,
          truncated: truncated.truncated,
          timedOut
        }
      });
    });
  });
}
