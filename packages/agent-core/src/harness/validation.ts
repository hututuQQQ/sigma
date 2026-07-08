import type { HarnessCommandResult } from "../types.js";
import { runBashCommand } from "../command-runner.js";

export interface ValidationCommandSpec {
  source: string;
  command: string;
  relatedFiles: string[];
  cwd?: string;
}

function tailText(text: string, limit = 4000): string {
  return text.length <= limit ? text : text.slice(-limit);
}

export async function runHarnessCommand(options: {
  kind: "validation" | "precheck";
  source: string;
  command: string;
  workspacePath: string;
  attempt: number;
  timeoutSec: number;
  relatedFiles?: string[];
  abortSignal?: AbortSignal;
}): Promise<HarnessCommandResult> {
  const startedAt = Date.now();
  const result = await runBashCommand({
    command: options.command,
    cwd: options.workspacePath,
    env: process.env,
    timeoutMs: Math.max(1, Math.floor(options.timeoutSec * 1000)),
    abortSignal: options.abortSignal
  });

  if (result.error) {
    return {
      kind: options.kind,
      source: options.source,
      command: options.command,
      attempt: options.attempt,
      exit_code: 127,
      stdout_tail: tailText(result.stdout.toString("utf8")),
      stderr_tail: result.error.message,
      related_files: options.relatedFiles ?? [],
      timeout_sec: options.timeoutSec,
      duration_ms: Date.now() - startedAt,
      settled_on: result.settledOn,
      signal: result.signal ?? undefined,
      timed_out: result.timedOut || undefined,
      cancelled: result.cancelled || undefined,
      message: `${options.kind} command failed: ${result.error.message}`
    };
  }

  const code = result.cancelled ? 130 : result.timedOut ? 124 : result.exitCode ?? 1;
  const stdoutTail = tailText(result.stdout.toString("utf8"));
  const stderrTail = tailText(result.stderr.toString("utf8"));
  const label = options.kind === "validation" ? "validation" : "precheck";
  return {
    kind: options.kind,
    source: options.source,
    command: options.command,
    attempt: options.attempt,
    exit_code: code,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    related_files: options.relatedFiles ?? [],
    timeout_sec: options.timeoutSec,
    duration_ms: result.durationMs,
    settled_on: result.settledOn,
    signal: result.signal ?? undefined,
    timed_out: result.timedOut || undefined,
    cancelled: result.cancelled || undefined,
    message: result.cancelled ? `${label} command cancelled` : code === 0 ? `${label} command passed` : `${label} command failed with exit code ${code}`
  };
}
