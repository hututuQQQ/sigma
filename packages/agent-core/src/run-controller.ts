import { createModelClient, type ModelClient, type ProviderName, type ProviderOptions } from "agent-ai";
import { runAgent } from "./agent.js";
import { AgentEventBus } from "./events.js";
import { runAgentHarness } from "./harness/index.js";
import { createMcpToolRegistry } from "./mcp.js";
import { createDefaultToolRegistry, mergeToolRegistries } from "./tools/index.js";
import type {
  AgentEventBusLike,
  AgentFinalEvidenceMode,
  AgentHarnessConfig,
  AgentHarnessValidationMode,
  AgentRunResult,
  AgentSkillsMode,
  ContextMode,
  McpServerRunSummary,
  PermissionDecider,
  PermissionMode,
  ToolRegistry
} from "./types.js";

export interface RunConfiguredAgentOptions {
  instruction: string;
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  modelClient?: ModelClient;
  modelClientFactory?: (provider: ProviderName, options: ProviderOptions) => ModelClient;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  maxWallTimeSec?: number;
  commandTimeoutSec?: number;
  traceJsonlPath?: string;
  sessionJsonlPath?: string;
  summaryJsonPath?: string;
  maxToolOutputChars?: number;
  maxMessageHistoryChars?: number;
  messageHistoryRetain?: number;
  compactionSummaryChars?: number;
  validationMode?: AgentHarnessValidationMode;
  validationCommands?: string[];
  validationRetryLimit?: number;
  validationTimeoutSec?: number;
  precheckCommand?: string;
  precheckTimeoutSec?: number;
  postRunCleanupGlobs?: string[];
  harnessTimeoutSec?: number;
  retryMinBudgetSec?: number;
  attemptsDir?: string;
  allowedTools?: string[];
  disabledTools?: string[];
  projectInstructionsEnabled?: boolean;
  projectDocMaxBytes?: number;
  contextMode?: ContextMode;
  repoMapMaxChars?: number;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  skillsMode?: AgentSkillsMode;
  skillsMaxChars?: number;
  enableMcp?: boolean;
  mcpConfig?: string;
  eventBus?: AgentEventBusLike;
  permissionDecider?: PermissionDecider;
  toolRegistry?: ToolRegistry;
  onMcpServers?: (servers: McpServerRunSummary[]) => void;
}

export interface RunConfiguredAgentResult {
  result: AgentRunResult;
  eventBus: AgentEventBusLike;
  mcpServers: McpServerRunSummary[];
}

export function shouldUseAgentRunController(options: {
  validationMode?: AgentHarnessValidationMode;
  validationCommands?: string[];
  validationRetryLimit?: number;
  precheckCommand?: string;
  postRunCleanupGlobs?: string[];
  harnessTimeoutSec?: number;
  retryMinBudgetSec?: number;
  attemptsDir?: string;
}): boolean {
  return (
    options.validationMode === "auto" ||
    (options.validationCommands?.length ?? 0) > 0 ||
    (options.validationRetryLimit ?? 0) > 0 ||
    Boolean(options.precheckCommand?.trim()) ||
    (options.postRunCleanupGlobs?.length ?? 0) > 0 ||
    Boolean(options.harnessTimeoutSec) ||
    Boolean(options.retryMinBudgetSec) ||
    Boolean(options.attemptsDir)
  );
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function baseRunConfig(options: RunConfiguredAgentOptions, modelClient: ModelClient): AgentHarnessConfig {
  return {
    instruction: options.instruction,
    workspacePath: options.workspacePath,
    modelClient,
    ...(defined(options.maxTurns) ? { maxTurns: options.maxTurns } : {}),
    ...(defined(options.maxWallTimeSec) ? { maxWallTimeSec: options.maxWallTimeSec } : {}),
    ...(defined(options.commandTimeoutSec) ? { commandTimeoutSec: options.commandTimeoutSec } : {}),
    ...(defined(options.permissionMode) ? { permissionMode: options.permissionMode } : {}),
    ...(defined(options.traceJsonlPath) ? { traceJsonlPath: options.traceJsonlPath } : {}),
    ...(defined(options.sessionJsonlPath) ? { sessionJsonlPath: options.sessionJsonlPath } : {}),
    ...(defined(options.summaryJsonPath) ? { summaryJsonPath: options.summaryJsonPath } : {}),
    ...(defined(options.maxToolOutputChars) ? { maxToolOutputChars: options.maxToolOutputChars } : {}),
    ...(defined(options.maxMessageHistoryChars) ? { maxMessageHistoryChars: options.maxMessageHistoryChars } : {}),
    ...(defined(options.messageHistoryRetain) ? { messageHistoryRetain: options.messageHistoryRetain } : {}),
    ...(defined(options.compactionSummaryChars) ? { compactionSummaryChars: options.compactionSummaryChars } : {}),
    ...(defined(options.allowedTools) ? { allowedTools: options.allowedTools } : {}),
    ...(defined(options.disabledTools) ? { disabledTools: options.disabledTools } : {}),
    ...(defined(options.permissionDecider) ? { permissionDecider: options.permissionDecider } : {}),
    ...(defined(options.projectInstructionsEnabled)
      ? { projectInstructionsEnabled: options.projectInstructionsEnabled }
      : {}),
    ...(defined(options.projectDocMaxBytes) ? { projectDocMaxBytes: options.projectDocMaxBytes } : {}),
    ...(defined(options.contextMode) ? { contextMode: options.contextMode } : {}),
    ...(defined(options.repoMapMaxChars) ? { repoMapMaxChars: options.repoMapMaxChars } : {}),
    ...(defined(options.finalEvidenceMode) ? { finalEvidenceMode: options.finalEvidenceMode } : {}),
    ...(defined(options.skillsMode) ? { skillsMode: options.skillsMode } : {}),
    ...(defined(options.skillsMaxChars) ? { skillsMaxChars: options.skillsMaxChars } : {}),
    ...(defined(options.eventBus) ? { eventBus: options.eventBus } : {})
  };
}

export async function runConfiguredAgent(
  options: RunConfiguredAgentOptions
): Promise<RunConfiguredAgentResult> {
  const eventBus = options.eventBus ?? new AgentEventBus();
  const modelClient = options.modelClient ?? (options.modelClientFactory ?? createModelClient)(options.provider, {
    model: options.model
  });
  let toolRegistry = options.toolRegistry;
  let mcpServers: McpServerRunSummary[] = [];

  if (options.enableMcp) {
    const mcp = await createMcpToolRegistry({
      workspacePath: options.workspacePath,
      configPath: options.mcpConfig
    });
    mcpServers = mcp.servers;
    options.onMcpServers?.(mcpServers);
    toolRegistry = mergeToolRegistries([toolRegistry ?? createDefaultToolRegistry(), mcp.registry]);
  }

  const runConfig: AgentHarnessConfig = {
    ...baseRunConfig({ ...options, eventBus }, modelClient),
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(defined(options.validationMode) ? { validationMode: options.validationMode } : {}),
    ...(defined(options.validationCommands) ? { validationCommands: options.validationCommands } : {}),
    ...(defined(options.validationRetryLimit) ? { validationRetryLimit: options.validationRetryLimit } : {}),
    ...(defined(options.validationTimeoutSec) ? { validationTimeoutSec: options.validationTimeoutSec } : {}),
    ...(defined(options.precheckCommand) ? { precheckCommand: options.precheckCommand } : {}),
    ...(defined(options.precheckTimeoutSec) ? { precheckTimeoutSec: options.precheckTimeoutSec } : {}),
    ...(defined(options.postRunCleanupGlobs) ? { postRunCleanupGlobs: options.postRunCleanupGlobs } : {}),
    ...(defined(options.harnessTimeoutSec) ? { harnessTimeoutSec: options.harnessTimeoutSec } : {}),
    ...(defined(options.retryMinBudgetSec) ? { retryMinBudgetSec: options.retryMinBudgetSec } : {}),
    ...(defined(options.attemptsDir) ? { attemptsDir: options.attemptsDir } : {})
  };

  const result = shouldUseAgentRunController(options)
    ? await runAgentHarness(runConfig)
    : await runAgent(runConfig);
  return { result, eventBus, mcpServers };
}
