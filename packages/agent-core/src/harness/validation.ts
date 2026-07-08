import path from "node:path";
import { runSandboxedBashCommand } from "../exec-runtime.js";
import { createDefaultSandboxConfig } from "../sandbox.js";
import { evaluateExecPolicy } from "../policy.js";
import type { ExecPolicyConfig, HarnessCommandResult, SandboxAdapter, SandboxConfig, ToolExecutionContext } from "../types.js";

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
  cwd?: string;
  attempt: number;
  timeoutSec: number;
  relatedFiles?: string[];
  execPolicy?: ExecPolicyConfig;
  sandbox?: SandboxConfig;
  sandboxAdapter?: SandboxAdapter;
  abortSignal?: AbortSignal;
}): Promise<HarnessCommandResult> {
  const startedAt = Date.now();
  const workspacePath = path.resolve(options.workspacePath);
  const cwd = path.resolve(options.cwd ?? options.workspacePath);
  const label = options.kind === "validation" ? "validation" : "precheck";
  const policy = evaluateExecPolicy(options.command, options.execPolicy ?? { defaultAction: "allow" });
  if (policy.action === "deny") {
    return {
      kind: options.kind,
      source: options.source,
      command: options.command,
      attempt: options.attempt,
      exit_code: 126,
      stdout_tail: "",
      stderr_tail: policy.reason,
      related_files: options.relatedFiles ?? [],
      timeout_sec: options.timeoutSec,
      duration_ms: Date.now() - startedAt,
      message: `${label} command denied by execution policy`
    };
  }

  const context: ToolExecutionContext = {
    workspacePath,
    permissionMode: "yolo",
    commandTimeoutSec: options.timeoutSec,
    maxToolOutputChars: 4000,
    runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
    alwaysAllowTools: new Set<string>(),
    execPolicy: options.execPolicy,
    sandbox: options.sandbox ?? createDefaultSandboxConfig(),
    sandboxAdapter: options.sandboxAdapter,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
  };

  const execution = await runSandboxedBashCommand({
    toolName: `harness.${options.kind}`,
    command: options.command,
    cwd,
    env: process.env,
    timeoutMs: Math.max(1, Math.floor(options.timeoutSec * 1000)),
    abortSignal: options.abortSignal,
    policy,
    context
  });
  if ("allowed" in execution) {
    return {
      kind: options.kind,
      source: options.source,
      command: options.command,
      attempt: options.attempt,
      exit_code: 126,
      stdout_tail: "",
      stderr_tail: execution.reason ?? "Command was denied by sandbox policy.",
      related_files: options.relatedFiles ?? [],
      timeout_sec: options.timeoutSec,
      duration_ms: Date.now() - startedAt,
      sandbox: execution.metadata,
      message: `${label} command denied by sandbox policy`
    };
  }
  const { result, sandbox } = execution;

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
      sandbox,
      message: `${options.kind} command failed: ${result.error.message}`
    };
  }

  const code = result.cancelled ? 130 : result.timedOut ? 124 : result.exitCode ?? 1;
  const stdoutTail = tailText(result.stdout.toString("utf8"));
  const stderrTail = tailText(result.stderr.toString("utf8"));
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
    sandbox,
    message: result.cancelled ? `${label} command cancelled` : code === 0 ? `${label} command passed` : `${label} command failed with exit code ${code}`
  };
}
