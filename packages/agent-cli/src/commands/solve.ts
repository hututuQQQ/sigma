import { readFile } from "node:fs/promises";
import { stdin as processStdin } from "node:process";
import type { ModelClient, ProviderName, ProviderOptions } from "agent-ai";
import { createModelClient } from "agent-ai";
import {
  AgentEventBus,
  createDefaultToolRegistry,
  createMcpToolRegistry,
  mergeToolRegistries,
  redactSecretText,
  runAgent,
  runAgentHarness,
  truncateMiddle,
  type McpServerRunSummary,
  type ToolRegistry
} from "agent-core";
import { loadCliConfig, parseArgs } from "../config.js";
import { printRunResult } from "../output.js";
import { createInteractivePermissionDecider } from "../permission.js";
import { attachStreamUi } from "../stream-ui.js";

export interface SolveCommandDeps {
  modelClientFactory?: (provider: ProviderName, options: ProviderOptions) => ModelClient;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
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
  deps: SolveCommandDeps
): Promise<string> {
  if (typeof flags.instruction === "string") {
    return flags.instruction;
  }

  if (typeof flags["instruction-file"] === "string") {
    return await readFile(flags["instruction-file"], "utf8");
  }

  const stdin = deps.stdin ?? processStdin;
  if (!stdin.isTTY) {
    const content = await readStdin(stdin);
    if (content.trim().length > 0) return content;
  }

  throw new Error("No instruction supplied. Use --instruction, --instruction-file, or pipe text on stdin.");
}

function shouldUseHarness(cliConfig: ReturnType<typeof loadCliConfig>): boolean {
  return (
    cliConfig.validationMode === "auto" ||
    cliConfig.validationCommands.length > 0 ||
    cliConfig.validationRetryLimit > 0 ||
    Boolean(cliConfig.precheckCommand?.trim()) ||
    cliConfig.postRunCleanupGlobs.length > 0 ||
    Boolean(cliConfig.harnessTimeoutSec) ||
    Boolean(cliConfig.retryMinBudgetSec) ||
    Boolean(cliConfig.attemptsDir)
  );
}

function writeMcpServerWarnings(servers: McpServerRunSummary[], stderr: NodeJS.WritableStream): void {
  for (const server of servers) {
    if (!server.enabled || !server.error) continue;
    const name = redactSecretText(server.name).replace(/\s+/g, "_");
    const error = truncateMiddle(redactSecretText(server.error.replace(/\s+/g, " ").trim()), 300).text;
    stderr.write(`[sigma] mcp_error server=${name} error=${error}\n`);
  }
}

export async function runSolveCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const stdin = deps.stdin ?? processStdin;
  const factory = deps.modelClientFactory ?? createModelClient;
  let detachStreamUi: (() => void) | undefined;

  try {
    const { flags } = parseArgs(argv);
    const cliConfig = loadCliConfig(flags);
    const instruction = await resolveInstruction(flags, deps);
    const modelClient = factory(cliConfig.provider, { model: cliConfig.model });
    const eventBus = new AgentEventBus();
    detachStreamUi = cliConfig.noStreamUi ? undefined : attachStreamUi(eventBus, stderr);
    const permissionDecider = cliConfig.permissionMode === "ask"
      ? createInteractivePermissionDecider({
          stdin,
          stdout: stdout as NodeJS.WritableStream & { isTTY?: boolean },
          stderr
        })
      : undefined;
    let toolRegistry: ToolRegistry | undefined;
    let mcpServers: McpServerRunSummary[] | undefined;
    if (cliConfig.enableMcp) {
      const mcp = await createMcpToolRegistry({
        workspacePath: cliConfig.workspace,
        configPath: cliConfig.mcpConfig
      });
      mcpServers = mcp.servers;
      writeMcpServerWarnings(mcpServers, stderr);
      toolRegistry = mergeToolRegistries([createDefaultToolRegistry(), mcp.registry]);
    }

    const runConfig = {
      instruction,
      workspacePath: cliConfig.workspace,
      modelClient,
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
      eventBus,
      ...(toolRegistry ? { toolRegistry } : {}),
      ...(mcpServers ? { mcpServers } : {})
    };

    const result = shouldUseHarness(cliConfig)
      ? await runAgentHarness({
          ...runConfig,
          validationMode: cliConfig.validationMode,
          validationCommands: cliConfig.validationCommands,
          validationRetryLimit: cliConfig.validationRetryLimit,
          validationTimeoutSec: cliConfig.validationTimeoutSec,
          precheckCommand: cliConfig.precheckCommand,
          precheckTimeoutSec: cliConfig.precheckTimeoutSec,
          postRunCleanupGlobs: cliConfig.postRunCleanupGlobs,
          harnessTimeoutSec: cliConfig.harnessTimeoutSec,
          retryMinBudgetSec: cliConfig.retryMinBudgetSec,
          attemptsDir: cliConfig.attemptsDir
        })
      : await runAgent(runConfig);

    detachStreamUi?.();
    printRunResult(result, stdout);
    return result.status === "error" ? 1 : 0;
  } catch (error) {
    detachStreamUi?.();
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
