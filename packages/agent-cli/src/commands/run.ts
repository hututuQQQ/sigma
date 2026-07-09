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

function printNonInteractiveHelp(stdout: NodeJS.WritableStream): void {
  stdout.write(`agent run [instruction] [flags]

Run the autonomous coding agent once.

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
  --sandbox <read-only|workspace-write|danger-full-access|policy-only|external>
  --sandbox-backend <auto|bubblewrap|seatbelt|windows|external|policy-only>
  --sandbox-required
  --sandbox-network <default|restricted|disabled>
  --sandbox-add-read <comma-separated-paths>
  --sandbox-add-write <comma-separated-paths>
  --sandbox-deny-read <comma-separated-paths>
  --sandbox-deny-write <comma-separated-paths>
  --sandbox-external-command <command>

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
  --permission-rules <json>
  --loop-guard-mode <off|warn|stop>        off disables; warn nudges only; stop nudges then stops repeated calls
  --model-context-chars <number>
  --memory-scopes <comma-separated>
  --context-mode <off|repo-map>
  --repo-map-max-chars <number>
  --max-message-history-chars <number>
  --message-history-retain <number>
  --compaction-summary-chars <number>
  --final-evidence-mode <off|auto>
  --skills-mode <off|auto>
  --skills-max-chars <number>
  --no-subagents
  --no-subagent-background
  --subagent-heartbeat-timeout-sec <number> interrupt stalled background subagent jobs
  --subagent-max-turns <number>
  --subagent-max-output-chars <number>
  --review-anti-gaming / --no-review-anti-gaming
  --compaction-mode <off|deterministic|model-sub-session>
  --compaction-model <model>
  --compaction-provider <deepseek|glm>
  --compaction-max-input-chars <number>
  --compaction-max-output-chars <number>
  --compaction-timeout-sec <number>
  --compaction-fallback <deterministic|fail>
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
      printNonInteractiveHelp(stdout);
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
      sandbox: cliConfig.sandbox,
      traceJsonlPath: cliConfig.traceJsonl,
      sessionJsonlPath: cliConfig.sessionJsonl,
      summaryJsonPath: cliConfig.summaryJson,
      maxToolOutputChars: cliConfig.maxToolOutputChars,
      maxMessageHistoryChars: cliConfig.maxMessageHistoryChars,
      messageHistoryRetain: cliConfig.messageHistoryRetain,
      compactionSummaryChars: cliConfig.compactionSummaryChars,
      compactionMode: cliConfig.compactionMode,
      compactionModel: cliConfig.compactionModel,
      compactionProvider: cliConfig.compactionProvider,
      compactionMaxInputChars: cliConfig.compactionMaxInputChars,
      compactionMaxOutputChars: cliConfig.compactionMaxOutputChars,
      compactionTimeoutSec: cliConfig.compactionTimeoutSec,
      compactionFallback: cliConfig.compactionFallback,
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
      permissionRules: cliConfig.permissionRules,
      loopGuardMode: cliConfig.loopGuardMode,
      memoryScopes: cliConfig.memoryScopes,
      permissionDecider,
      projectInstructionsEnabled: !cliConfig.noProjectInstructions,
      projectDocMaxBytes: cliConfig.projectDocMaxBytes,
      contextMode: cliConfig.contextMode,
      repoMapMaxChars: cliConfig.repoMapMaxChars,
      modelContextLimits: cliConfig.modelContextLimits,
      finalEvidenceMode: cliConfig.finalEvidenceMode,
      skillsMode: cliConfig.skillsMode,
      skillsMaxChars: cliConfig.skillsMaxChars,
      subagentsEnabled: cliConfig.subagentsEnabled,
      subagentBackgroundEnabled: cliConfig.subagentBackgroundEnabled,
      subagentHeartbeatTimeoutSec: cliConfig.subagentHeartbeatTimeoutSec,
      subagentMaxTurns: cliConfig.subagentMaxTurns,
      subagentMaxOutputChars: cliConfig.subagentMaxOutputChars,
      reviewAntiGaming: cliConfig.reviewAntiGaming,
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
  return await runNonInteractiveCommand(argv, deps);
}

export async function runRunCommandWithOverrides(
  argv: string[],
  deps: SolveCommandDeps = {},
  overrides: RunCommandOverrides = {}
): Promise<number> {
  return await runNonInteractiveCommand(argv, deps, overrides);
}
