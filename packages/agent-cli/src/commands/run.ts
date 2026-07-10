import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { AgentEventEnvelope, ModelGateway, RunMode, RunOutcome } from "agent-protocol";
import { createConfiguredRuntime, type ConfiguredRuntime, type InProcessRuntimeClient } from "agent-runtime";
import { loadCliConfig, parseArgs, workspaceMcpTrustMessage, type CliConfig } from "../config.js";

export interface RunCommandDeps {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  stderr?: NodeJS.WritableStream;
  gatewayFactory?: (options: { provider: "deepseek" | "glm"; model: string }) => ModelGateway;
  mode?: RunMode;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function instructionFromArgs(
  flags: Record<string, unknown>,
  positionals: string[],
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
): Promise<string> {
  if (typeof flags["prompt-file"] === "string") return (await readFile(flags["prompt-file"], "utf8")).trim();
  if (typeof flags.prompt === "string") return flags.prompt.trim();
  if (flags.stdin === true || (!stdin.isTTY && positionals.length === 0)) return (await readStream(stdin)).trim();
  return positionals.join(" ").trim();
}

function status(outcome: RunOutcome): "completed" | "needs_input" | "cancelled" | "error" {
  if (outcome.kind === "completed") return "completed";
  if (outcome.kind === "needs_input") return "needs_input";
  if (outcome.kind === "cancelled") return "cancelled";
  return "error";
}

function exitCode(outcome: RunOutcome): number {
  if (outcome.kind === "completed") return 0;
  if (outcome.kind === "needs_input") return 2;
  if (outcome.kind === "cancelled") return 130;
  return 1;
}

function outcomeMessage(outcome: RunOutcome): string {
  if (outcome.kind === "completed") return outcome.message;
  if (outcome.kind === "cancelled") return outcome.reason;
  return outcome.message;
}

async function promptApproval(
  event: AgentEventEnvelope,
  runtime: InProcessRuntimeClient,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stderr: NodeJS.WritableStream
): Promise<void> {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
  const data = event.payload as Record<string, unknown>;
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  if (!requestId) return;
  const readline = createInterface({ input: stdin, output: stderr });
  try {
    const answer = (await readline.question(`Allow ${String(data.toolName ?? "tool")} (${String(data.reason ?? "")})? [y/N/a] `)).trim().toLowerCase();
    const decision = answer === "a" ? "always_allow" : answer === "y" || answer === "yes" ? "allow" : "deny";
    await runtime.command({ type: "approve", sessionId: event.sessionId, requestId, decision });
  } finally {
    readline.close();
  }
}

function writeEvent(event: AgentEventEnvelope, format: string, stderr: NodeJS.WritableStream, stdout: NodeJS.WritableStream): void {
  if (format === "stream-json") {
    stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (format === "json") return;
  if (event.type === "model.delta" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const delta = (event.payload as Record<string, unknown>).delta;
    if (typeof delta === "string") stderr.write(delta);
  } else if (event.type === "tool.started") {
    stderr.write(`\n[sigma] tool started\n`);
  } else if (event.type === "tool.completed" || event.type === "tool.failed") {
    stderr.write(`[sigma] ${event.type}\n`);
  }
}

async function streamSession(
  runtime: InProcessRuntimeClient,
  sessionId: string,
  config: CliConfig,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  signal: AbortSignal
): Promise<void> {
  for await (const event of runtime.subscribe(sessionId, signal)) {
    writeEvent(event, config.outputFormat, stderr, stdout);
    if (event.type === "tool.approval_requested") await promptApproval(event, runtime, stdin, stderr);
    if (event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed") break;
  }
}

function writeResult(
  outcome: RunOutcome,
  sessionId: string,
  format: CliConfig["outputFormat"],
  stdout: NodeJS.WritableStream
): void {
  const result = {
    status: status(outcome),
    finishReason: outcome.kind,
    sessionId,
    finalMessage: outcomeMessage(outcome)
  };
  if (format === "json") stdout.write(`${JSON.stringify(result)}\n`);
  else if (format === "stream-json") stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
  else stdout.write(`\n${result.finalMessage}\n`);
}

async function executeRun(
  configured: ConfiguredRuntime,
  config: CliConfig,
  instruction: string,
  mode: RunMode,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): Promise<number> {
  const { runtime, workspace } = configured;
  const session = await runtime.createSession({ workspacePath: workspace, mode, title: instruction.slice(0, 80) });
  const streamAbort = new AbortController();
  const stream = streamSession(runtime, session.sessionId, config, stdin, stdout, stderr, streamAbort.signal);
  try {
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: instruction, mode });
    const outcome = await runtime.waitForOutcome(session.sessionId);
    streamAbort.abort();
    await stream;
    writeResult(outcome, session.sessionId, config.outputFormat, stdout);
    return exitCode(outcome);
  } finally {
    streamAbort.abort();
    await stream.catch(() => undefined);
  }
}

function nonInteractiveAsk(config: CliConfig, stdinTty: boolean, stdoutTty: boolean): boolean {
  return config.permissionMode === "ask" && (!stdinTty || !stdoutTty);
}

function writeNeedsInput(
  config: CliConfig,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  message = "Non-interactive ask mode cannot resolve tool approvals. Use --permission-mode auto or the TUI.",
  finishReason = "permission_required"
): void {
  const result = {
    status: "needs_input",
    finishReason,
    message
  };
  if (config.outputFormat === "json" || config.outputFormat === "stream-json") stdout.write(`${JSON.stringify(result)}\n`);
  else stderr.write(`${result.message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCommand(argv: string[], deps: RunCommandDeps = {}): Promise<number> {
  const stdin = deps.stdin ?? processStdin;
  const stdout = deps.stdout ?? processStdout;
  const stderr = deps.stderr ?? processStderr;
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout.write(`Usage: agent ${deps.mode === "analyze" ? "inspect" : "run"} [instruction] [--workspace <path>] [--permission-mode ask|auto|deny] [--output-format text|json|stream-json]\n`);
      return 0;
    }
    const parsed = parseArgs(argv);
    const config = loadCliConfig(parsed.flags);
    const instruction = await instructionFromArgs(parsed.flags, parsed.positionals, stdin);
    if (!instruction) throw new Error("A non-empty instruction is required.");
    const mode = deps.mode ?? "change";
    const trustMessage = workspaceMcpTrustMessage(config);
    if (trustMessage) {
      writeNeedsInput(config, stdout, stderr, trustMessage, "workspace_mcp_trust_required");
      return 2;
    }
    if (nonInteractiveAsk(config, stdin.isTTY === true, stdout.isTTY === true)) {
      writeNeedsInput(config, stdout, stderr);
      return 2;
    }
    const configured = await createConfiguredRuntime(config, deps);
    try {
      return await executeRun(configured, config, instruction, mode, stdin, stdout, stderr);
    } finally {
      await configured.close();
    }
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}
