import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type StdioOptions } from "node:child_process";
import { bashExecutable, runCommand, type CommandResult, type RunCommandOptions } from "./command-runner.js";
import { createDefaultSandboxAdapter } from "./sandbox.js";
import type { ExecIntentSummary, SandboxExecDecision, ToolExecutionContext } from "./types.js";

export interface SandboxedRunResult {
  result: CommandResult;
  sandbox: Record<string, unknown> | undefined;
}

export interface SandboxedSpawnResult {
  child: ChildProcess;
  sandbox: Record<string, unknown> | undefined;
}

export interface SandboxedInteractiveShellResult {
  child: ChildProcessWithoutNullStreams;
  sandbox: Record<string, unknown> | undefined;
}

interface PrepareOptions {
  toolName: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  policy: ExecIntentSummary;
  context: ToolExecutionContext;
}

interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
}

function specFromDecision(originalCommand: string, decision: SandboxExecDecision, fallbackArgs?: string[]): ProcessSpec {
  if (decision.args) {
    return {
      command: decision.command ?? bashExecutable(),
      args: decision.args,
      cwd: decision.cwd ?? process.cwd(),
      env: decision.env,
      metadata: decision.metadata
    };
  }
  if (decision.command) {
    return {
      command: bashExecutable(),
      args: ["-lc", decision.command],
      cwd: decision.cwd ?? process.cwd(),
      env: decision.env,
      metadata: decision.metadata
    };
  }
  return {
    command: bashExecutable(),
    args: fallbackArgs ?? ["-lc", originalCommand],
    cwd: decision.cwd ?? process.cwd(),
    env: decision.env,
    metadata: decision.metadata
  };
}

async function prepareSandboxedProcess(options: PrepareOptions, fallbackArgs?: string[]): Promise<ProcessSpec | SandboxExecDecision> {
  const adapter = options.context.sandboxAdapter ?? createDefaultSandboxAdapter();
  const decision = await adapter.prepareExec({
    toolName: options.toolName,
    command: options.command,
    cwd: options.cwd,
    workspacePath: options.context.workspacePath,
    env: options.env ?? process.env,
    policy: options.policy,
    sandbox: options.context.sandbox ?? { mode: "disabled" }
  });
  if (!decision.allowed) return decision;
  return specFromDecision(options.command, decision, fallbackArgs);
}

export async function runSandboxedBashCommand(
  options: Omit<RunCommandOptions, "command" | "args"> & {
    command: string;
    policy: ExecIntentSummary;
    toolName: string;
    context: ToolExecutionContext;
  }
): Promise<SandboxedRunResult | SandboxExecDecision> {
  const prepared = await prepareSandboxedProcess({
    toolName: options.toolName,
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    policy: options.policy,
    context: options.context
  });
  if ("allowed" in prepared) return prepared;
  const spec = prepared as ProcessSpec;
  const result = await runCommand({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    timeoutMs: options.timeoutMs,
    drainMs: options.drainMs,
    killSettleMs: options.killSettleMs,
    termToKillMs: options.termToKillMs,
    detachedProcessGroup: options.detachedProcessGroup,
    windowsHide: true,
    abortSignal: options.abortSignal
  });
  return { result, sandbox: spec.metadata };
}

export async function spawnSandboxedBashCommand(options: {
  toolName: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  policy: ExecIntentSummary;
  context: ToolExecutionContext;
  detached?: boolean;
  stdio?: StdioOptions;
}): Promise<SandboxedSpawnResult | SandboxExecDecision> {
  const prepared = await prepareSandboxedProcess({
    toolName: options.toolName,
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    policy: options.policy,
    context: options.context
  });
  if ("allowed" in prepared) return prepared;
  const spec = prepared as ProcessSpec;
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: true
  });
  return { child, sandbox: spec.metadata };
}

export async function spawnSandboxedInteractiveShell(options: {
  toolName: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  policy: ExecIntentSummary;
  context: ToolExecutionContext;
}): Promise<SandboxedInteractiveShellResult | SandboxExecDecision> {
  const prepared = await prepareSandboxedProcess({
    toolName: options.toolName,
    command: "bash --noprofile --norc",
    cwd: options.cwd,
    env: options.env,
    policy: options.policy,
    context: options.context
  }, ["--noprofile", "--norc"]);
  if ("allowed" in prepared) return prepared;
  const spec = prepared as ProcessSpec;
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    detached: process.platform !== "win32",
    windowsHide: true
  }) as ChildProcessWithoutNullStreams;
  return { child, sandbox: spec.metadata };
}
