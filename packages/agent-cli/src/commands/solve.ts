import { readFile } from "node:fs/promises";
import { stdin as processStdin } from "node:process";
import type { ModelClient, ProviderName, ProviderOptions } from "agent-ai";
import { createModelClient } from "agent-ai";
import {
  AgentEventBus,
  redactSecretText,
  runConfiguredAgent,
  truncateMiddle,
  type McpServerRunSummary
} from "agent-core";
import { loadCliConfig, parseArgs } from "../config.js";
import { printJsonRunResult, printRunResult, writeJsonLine, writeStreamJsonEvent } from "../output.js";
import { createInteractivePermissionDecider } from "../permission.js";
import { attachStreamUi } from "../stream-ui.js";

export interface SolveCommandDeps {
  modelClientFactory?: (provider: ProviderName, options: ProviderOptions) => ModelClient;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

export interface RunCommandOverrides {
  instruction?: string;
  workspacePath?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveInstruction(
  flags: Record<string, string | boolean>,
  positionals: string[],
  deps: SolveCommandDeps
): Promise<string> {
  if (typeof flags.instruction === "string") {
    return flags.instruction;
  }

  if (typeof flags["instruction-file"] === "string") {
    return await readFile(flags["instruction-file"], "utf8");
  }

  if (positionals.length > 0) {
    return positionals.join(" ");
  }

  const stdin = deps.stdin ?? processStdin;
  if (!stdin.isTTY) {
    const content = await readStdin(stdin);
    if (content.trim().length > 0) return content;
  }

  throw new Error("No instruction supplied. Use --instruction, --instruction-file, or pipe text on stdin.");
}

function writeMcpServerWarnings(servers: McpServerRunSummary[], stderr: NodeJS.WritableStream): void {
  for (const server of servers) {
    if (!server.enabled || !server.error) continue;
    const name = redactSecretText(server.name).replace(/\s+/g, "_");
    const error = truncateMiddle(redactSecretText(server.error.replace(/\s+/g, " ").trim()), 300).text;
    stderr.write(`[sigma] mcp_error server=${name} error=${error}\n`);
  }
}

function printNonInteractiveHelp(commandName: "run" | "solve", stdout: NodeJS.WritableStream): void {
  const aliasNote = commandName === "solve" ? "Compatibility alias for agent run." : "Run the autonomous coding agent once.";
  stdout.write(`${commandName === "solve" ? "agent solve" : "agent run"} [instruction] [flags]

${aliasNote}

Instruction input:
  agent run "Fix failing tests"
  agent run --instruction "Fix failing tests"
  agent run --instruction-file ./task.md
  printf "Fix failing tests" | agent run

Core flags:
  --workspace <path>
  --provider <deepseek|glm>
  --model <name>
  --permission-mode <ask|yolo>
  --max-turns <number>
  --max-wall-time-sec <number>
  --command-timeout-sec <number>

Run-controller flags:
  --validation-mode <off|auto>
  --validation-command <command>
  --validation-commands <comma-separated>
  --validation-retry-limit <number>
  --validation-timeout-sec <number>
  --precheck-command <command>
  --precheck-timeout-sec <number>
  --harness-timeout-sec <number>
  --retry-min-budget-sec <number>
  --attempts-dir <path>

Context and tool flags:
  --allowed-tools <comma-separated>
  --disabled-tools <comma-separated>
  --context-mode <off|repo-map>
  --repo-map-max-chars <number>
  --final-evidence-mode <off|auto>
  --skills-mode <off|auto>
  --skills-max-chars <number>
  --enable-mcp
  --mcp-config <path>

Output flags:
  --output-format <text|json|stream-json>
  --json
  --quiet
  --stream-ui / --no-stream-ui
  --trace-jsonl <path>
  --session-jsonl <path>
  --summary-json <path>
`);
}

async function runNonInteractiveCommand(
  argv: string[],
  deps: SolveCommandDeps,
  commandName: "run" | "solve",
  overrides: RunCommandOverrides = {}
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const stdin = deps.stdin ?? processStdin;
  const factory = deps.modelClientFactory ?? createModelClient;
  let detachStreamUi: (() => void) | undefined;
  let detachJsonStream: (() => void) | undefined;

  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      printNonInteractiveHelp(commandName, stdout);
      return 0;
    }

    const { flags, positionals } = parseArgs(argv);
    const cliConfig = loadCliConfig(flags);
    const instruction = overrides.instruction ?? await resolveInstruction(flags, positionals, deps);
    const workspacePath = overrides.workspacePath ?? cliConfig.workspace;
    const eventBus = new AgentEventBus();
    detachJsonStream = cliConfig.outputFormat === "stream-json"
      ? eventBus.on((event) => writeStreamJsonEvent(event, stdout))
      : undefined;
    detachStreamUi = cliConfig.noStreamUi ? undefined : attachStreamUi(eventBus, stderr);
    const permissionDecider = cliConfig.permissionMode === "ask"
      ? createInteractivePermissionDecider({
          stdin,
          stdout: stdout as NodeJS.WritableStream & { isTTY?: boolean },
          stderr
        })
      : undefined;

    const { result } = await runConfiguredAgent({
      instruction,
      workspacePath,
      provider: cliConfig.provider,
      model: cliConfig.model,
      parentSessionId: overrides.parentSessionId,
      forkedFromSessionId: overrides.forkedFromSessionId,
      modelClientFactory: factory,
      maxTurns: cliConfig.maxTurns,
      maxWallTimeSec: cliConfig.maxWallTimeSec,
      commandTimeoutSec: cliConfig.commandTimeoutSec,
      permissionMode: cliConfig.permissionMode,
      traceJsonlPath: cliConfig.traceJsonl,
      sessionJsonlPath: cliConfig.sessionJsonl,
      summaryJsonPath: cliConfig.summaryJson,
      maxToolOutputChars: cliConfig.maxToolOutputChars,
      maxMessageHistoryChars: cliConfig.maxMessageHistoryChars,
      messageHistoryRetain: cliConfig.messageHistoryRetain,
      compactionSummaryChars: cliConfig.compactionSummaryChars,
      validationMode: cliConfig.validationMode,
      validationCommands: cliConfig.validationCommands,
      validationRetryLimit: cliConfig.validationRetryLimit,
      validationTimeoutSec: cliConfig.validationTimeoutSec,
      precheckCommand: cliConfig.precheckCommand,
      precheckTimeoutSec: cliConfig.precheckTimeoutSec,
      postRunCleanupGlobs: cliConfig.postRunCleanupGlobs,
      harnessTimeoutSec: cliConfig.harnessTimeoutSec,
      retryMinBudgetSec: cliConfig.retryMinBudgetSec,
      attemptsDir: cliConfig.attemptsDir,
      allowedTools: cliConfig.allowedTools,
      disabledTools: cliConfig.disabledTools,
      permissionDecider,
      projectInstructionsEnabled: !cliConfig.noProjectInstructions,
      projectDocMaxBytes: cliConfig.projectDocMaxBytes,
      contextMode: cliConfig.contextMode,
      repoMapMaxChars: cliConfig.repoMapMaxChars,
      finalEvidenceMode: cliConfig.finalEvidenceMode,
      skillsMode: cliConfig.skillsMode,
      skillsMaxChars: cliConfig.skillsMaxChars,
      enableMcp: cliConfig.enableMcp,
      mcpConfig: cliConfig.mcpConfig,
      eventBus,
      onMcpServers: (servers) => writeMcpServerWarnings(servers, stderr)
    });

    detachStreamUi?.();
    detachJsonStream?.();
    if (cliConfig.outputFormat === "json") {
      printJsonRunResult(result, stdout);
    } else if (cliConfig.outputFormat === "stream-json") {
      writeJsonLine({ type: "result", result }, stdout);
    } else {
      printRunResult(result, stdout, { quiet: cliConfig.quiet });
    }
    return result.status === "error" ? 1 : 0;
  } catch (error) {
    detachStreamUi?.();
    detachJsonStream?.();
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runRunCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  return await runNonInteractiveCommand(argv, deps, "run");
}

export async function runSolveCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  return await runNonInteractiveCommand(argv, deps, "solve");
}

export async function runRunCommandWithOverrides(
  argv: string[],
  deps: SolveCommandDeps = {},
  overrides: RunCommandOverrides = {}
): Promise<number> {
  return await runNonInteractiveCommand(argv, deps, "run", overrides);
}
