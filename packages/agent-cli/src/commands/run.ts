import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { AgentEventEnvelope, ModelGateway, RunMode, RunOutcome, RuntimeClient } from "agent-protocol";
import {
  createConfiguredRuntime,
  type ConfiguredRuntime,
  type RuntimeFactoryDeps
} from "agent-runtime";
import {
  loadCliConfig, parseArgs, workspaceCustomizationTrustMessage, workspaceMcpTrustMessage, type CliConfig
} from "../config.js";
import { outputError, outputEvent, outputJsonLines, outputResult } from "../output-schema.js";

export interface RunCommandDeps extends RuntimeFactoryDeps {
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
  runtime: RuntimeClient,
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

function approvalRequiresPrompt(event: AgentEventEnvelope): boolean {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  return (event.payload as Record<string, unknown>).approvalMode !== "automatic";
}

function writeEvent(event: AgentEventEnvelope, config: CliConfig, stderr: NodeJS.WritableStream, stdout: NodeJS.WritableStream): void {
  const format = config.outputFormat;
  if (format === "stream-json") {
    for (const line of outputJsonLines(
      outputEvent(event, config.outputSchema), event.eventId, config.streamJsonMaxLineBytes
    )) stdout.write(`${line}\n`);
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
  runtime: RuntimeClient,
  sessionId: string,
  config: CliConfig,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  signal: AbortSignal
): Promise<"run.completed" | "run.cancelled" | "run.failed" | "run.suspended"> {
  let lastEventType = "none";
  for await (const event of runtime.subscribe(sessionId, signal)) {
    lastEventType = event.type;
    writeEvent(event, config, stderr, stdout);
    if (event.type === "tool.approval_requested" && approvalRequiresPrompt(event) && stdin.isTTY === true) {
      await promptApproval(event, runtime, stdin, stderr);
    }
    if (event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed") {
      return event.type;
    }
    if (event.type === "run.suspended" && event.payload && typeof event.payload === "object"
      && !Array.isArray(event.payload)
      && (event.payload as Record<string, unknown>).kind === "needs_input") return event.type;
  }
  throw Object.assign(new Error(
    `CLI session event stream ended without a terminal event (session=${sessionId}, lastEventType=${lastEventType}).`
  ), { code: "cli_terminal_event_missing" });
}

function expectedTerminalEvent(outcome: RunOutcome): "run.completed" | "run.cancelled" | "run.failed" | "run.suspended" {
  if (outcome.kind === "completed") return "run.completed";
  if (outcome.kind === "cancelled") return "run.cancelled";
  if (outcome.kind === "needs_input") return "run.suspended";
  return "run.failed";
}

function writeResult(
  outcome: RunOutcome,
  sessionId: string,
  config: CliConfig,
  stdout: NodeJS.WritableStream
): void {
  const result = {
    status: status(outcome),
    finishReason: outcome.kind,
    sessionId,
    finalMessage: outcomeMessage(outcome)
  };
  if (config.outputFormat === "stream-json") {
    for (const line of outputJsonLines(
      outputResult(result, config.outputSchema), `result:${sessionId}`, config.streamJsonMaxLineBytes
    )) stdout.write(`${line}\n`);
  } else if (config.outputFormat === "json") stdout.write(`${JSON.stringify(outputResult(result, config.outputSchema))}\n`);
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
  const session = await runtime.createSession({
    workspacePath: workspace,
    mode,
    goal: instruction,
    title: instruction.slice(0, 80),
    ...(config.reviewerWaiver ? { reviewerWaiverReason: "Explicit --waive-reviewer CLI flag." } : {})
  });
  const streamAbort = new AbortController();
  const stream = streamSession(runtime, session.sessionId, config, stdin, stdout, stderr, streamAbort.signal);
  try {
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: instruction, mode });
    const [outcome, terminalEvent] = await Promise.all([
      runtime.waitForOutcome(session.sessionId),
      stream
    ]);
    const expected = expectedTerminalEvent(outcome);
    if (terminalEvent !== expected) {
      throw Object.assign(new Error(
        `CLI terminal event '${terminalEvent}' does not match outcome '${outcome.kind}' (expected '${expected}').`
      ), { code: "cli_terminal_result_mismatch" });
    }
    writeResult(outcome, session.sessionId, config, stdout);
    return exitCode(outcome);
  } finally {
    streamAbort.abort();
    await stream.catch(() => undefined);
    await runtime.releaseSession?.(session.sessionId);
  }
}

function nonInteractiveAsk(config: CliConfig, stdinTty: boolean, stdoutTty: boolean): boolean {
  return config.permissionMode === "ask" && (!stdinTty || !stdoutTty);
}

function interactiveApprovalSurface(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
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
  if (config.outputFormat === "stream-json") {
    for (const line of outputJsonLines(
      outputResult(result, config.outputSchema), "result:needs-input", config.streamJsonMaxLineBytes
    )) stdout.write(`${line}\n`);
  } else if (config.outputFormat === "json") stdout.write(`${JSON.stringify(outputResult(result, config.outputSchema))}\n`);
  else stderr.write(`${result.message}\n`);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && lines.length < 8) {
    seen.add(current);
    const details = current as Error & { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown };
    const fields = [
      typeof details.code === "string" ? `code=${details.code}` : null,
      typeof details.errno === "number" || typeof details.errno === "string" ? `errno=${String(details.errno)}` : null,
      typeof details.syscall === "string" ? `syscall=${details.syscall}` : null,
      typeof details.path === "string" ? `path=${details.path}` : null
    ].filter((value): value is string => value !== null);
    lines.push(`${lines.length === 0 ? "" : "caused by: "}${current.message}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`);
    current = current.cause;
  }
  return lines.join("\n");
}

function writeRunError(
  error: unknown,
  output: Pick<CliConfig, "outputFormat" | "outputSchema" | "streamJsonMaxLineBytes"> | undefined,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): void {
  const message = errorMessage(error);
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code : "cli_error";
  if (output?.outputFormat === "json") {
    stdout.write(`${JSON.stringify(outputResult({
      status: "error",
      finishReason: code,
      sessionId: "",
      finalMessage: message
    }, output.outputSchema))}\n`);
    return;
  }
  if (output?.outputFormat !== "stream-json") {
    stderr.write(`${message}\n`);
    return;
  }
  for (const line of outputJsonLines(
    outputError({ code, message }, output.outputSchema), `error:${code}`, output.streamJsonMaxLineBytes
  )) stdout.write(`${line}\n`);
}

export async function runCommand(argv: string[], deps: RunCommandDeps = {}): Promise<number> {
  const stdin = deps.stdin ?? processStdin;
  const stdout = deps.stdout ?? processStdout;
  const stderr = deps.stderr ?? processStderr;
  let errorOutput: Pick<CliConfig, "outputFormat" | "outputSchema" | "streamJsonMaxLineBytes"> | undefined;
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout.write(`Usage: agent ${deps.mode === "analyze" ? "inspect" : "run"} [instruction] [--workspace <path>] [--permission-mode ask|auto|deny] [--output-format text|json|stream-json]\n`);
      return 0;
    }
    const parsed = parseArgs(argv);
    const config = loadCliConfig(parsed.flags);
    errorOutput = config;
    const instruction = await instructionFromArgs(parsed.flags, parsed.positionals, stdin);
    if (!instruction) throw new Error("A non-empty instruction is required.");
    const mode = deps.mode ?? "change";
    const mcpTrustMessage = workspaceMcpTrustMessage(config);
    const customizationTrustMessage = workspaceCustomizationTrustMessage(config);
    const trustMessage = mcpTrustMessage ?? customizationTrustMessage;
    if (trustMessage) {
      writeNeedsInput(
        config,
        stdout,
        stderr,
        trustMessage,
        mcpTrustMessage ? "workspace_mcp_trust_required" : "workspace_customization_trust_required"
      );
      return 2;
    }
    if (nonInteractiveAsk(config, stdin.isTTY === true, stdout.isTTY === true)) {
      writeNeedsInput(config, stdout, stderr);
      return 2;
    }
    const configured = await createConfiguredRuntime(config, deps, {
      surface: "cli",
      interactiveApprovals: interactiveApprovalSurface(stdin, stdout)
    });
    try {
      return await executeRun(configured, config, instruction, mode, stdin, stdout, stderr);
    } finally {
      await configured.close();
    }
  } catch (error) {
    writeRunError(error, errorOutput, stdout, stderr);
    return 1;
  }
}
