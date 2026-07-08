import { createModelClient, type ModelClient, type ProviderName, type ProviderOptions } from "agent-ai";
import { runAgent } from "./agent.js";
import { AgentEventBus } from "./events.js";
import { runAgentHarness } from "./harness/index.js";
import { createMcpToolRegistry } from "./mcp.js";
import { createDefaultToolRegistry, mergeToolRegistries } from "./tools/index.js";
import {
  DEFAULT_COMPACTION_MODE,
  DEFAULT_FINAL_EVIDENCE_MODE,
  DEFAULT_MAX_MESSAGE_HISTORY_CHARS,
  DEFAULT_SUBAGENTS_ENABLED,
  DEFAULT_VALIDATION_MODE
} from "./defaults.js";
import type {
  AgentEventBusLike,
  AgentFinalEvidenceMode,
  AgentHarnessConfig,
  AgentHarnessValidationMode,
  AgentRunResult,
  AgentSkillsMode,
  CompactionFallbackMode,
  CompactionMode,
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
  sessionId?: string;
  sessionRootDir?: string;
  durableSession?: boolean;
  parentSessionId?: string;
  forkedFromSessionId?: string;
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
  compactionMode?: CompactionMode;
  compactionModel?: string;
  compactionProvider?: ProviderName;
  compactionMaxInputChars?: number;
  compactionMaxOutputChars?: number;
  compactionTimeoutSec?: number;
  compactionFallback?: CompactionFallbackMode;
  compactionModelClient?: ModelClient;
  contextManager?: import("./context/context-manager.js").ContextManager;
  contextManagerFactory?: AgentHarnessConfig["contextManagerFactory"];
  compactionService?: import("./context/compaction-service.js").CompactionService;
  failureAnalyzer?: import("./workflow/failure-analyzer.js").FailureAnalyzer;
  subagentsEnabled?: boolean;
  subagentMaxTurns?: number;
  subagentMaxOutputChars?: number;
  reviewAntiGaming?: boolean;
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
  abortSignal?: AbortSignal;
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
  finalEvidenceMode?: AgentFinalEvidenceMode;
  reviewAntiGaming?: boolean;
}): boolean {
  return (
    options.validationMode === "auto" ||
    (options.reviewAntiGaming !== false && options.finalEvidenceMode === "auto") ||
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

function baseRunConfig(
  options: RunConfiguredAgentOptions,
  modelClient: ModelClient,
  resolved: {
    compactionMode: CompactionMode;
    validationMode: AgentHarnessValidationMode;
    finalEvidenceMode: AgentFinalEvidenceMode;
    subagentsEnabled: boolean;
    reviewAntiGaming: boolean;
    maxMessageHistoryChars: number;
  }
): AgentHarnessConfig {
  return {
    instruction: options.instruction,
    workspacePath: options.workspacePath,
    modelClient,
    ...(defined(options.sessionId) ? { sessionId: options.sessionId } : {}),
    ...(defined(options.sessionRootDir) ? { sessionRootDir: options.sessionRootDir } : {}),
    ...(defined(options.durableSession) ? { durableSession: options.durableSession } : {}),
    ...(defined(options.parentSessionId) ? { parentSessionId: options.parentSessionId } : {}),
    ...(defined(options.forkedFromSessionId) ? { forkedFromSessionId: options.forkedFromSessionId } : {}),
    ...(defined(options.maxTurns) ? { maxTurns: options.maxTurns } : {}),
    ...(defined(options.maxWallTimeSec) ? { maxWallTimeSec: options.maxWallTimeSec } : {}),
    ...(defined(options.commandTimeoutSec) ? { commandTimeoutSec: options.commandTimeoutSec } : {}),
    ...(defined(options.permissionMode) ? { permissionMode: options.permissionMode } : {}),
    ...(defined(options.traceJsonlPath) ? { traceJsonlPath: options.traceJsonlPath } : {}),
    ...(defined(options.sessionJsonlPath) ? { sessionJsonlPath: options.sessionJsonlPath } : {}),
    ...(defined(options.summaryJsonPath) ? { summaryJsonPath: options.summaryJsonPath } : {}),
    ...(defined(options.maxToolOutputChars) ? { maxToolOutputChars: options.maxToolOutputChars } : {}),
    maxMessageHistoryChars: resolved.maxMessageHistoryChars,
    ...(defined(options.messageHistoryRetain) ? { messageHistoryRetain: options.messageHistoryRetain } : {}),
    ...(defined(options.compactionSummaryChars) ? { compactionSummaryChars: options.compactionSummaryChars } : {}),
    compactionMode: resolved.compactionMode,
    ...(defined(options.compactionModel) ? { compactionModel: options.compactionModel } : {}),
    ...(defined(options.compactionProvider) ? { compactionProvider: options.compactionProvider } : {}),
    ...(defined(options.compactionMaxInputChars) ? { compactionMaxInputChars: options.compactionMaxInputChars } : {}),
    ...(defined(options.compactionMaxOutputChars) ? { compactionMaxOutputChars: options.compactionMaxOutputChars } : {}),
    ...(defined(options.compactionTimeoutSec) ? { compactionTimeoutSec: options.compactionTimeoutSec } : {}),
    ...(defined(options.compactionFallback) ? { compactionFallback: options.compactionFallback } : {}),
    ...(defined(options.compactionModelClient) ? { compactionModelClient: options.compactionModelClient } : {}),
    ...(defined(options.contextManager) ? { contextManager: options.contextManager } : {}),
    ...(defined(options.contextManagerFactory) ? { contextManagerFactory: options.contextManagerFactory } : {}),
    ...(defined(options.compactionService) ? { compactionService: options.compactionService } : {}),
    ...(defined(options.failureAnalyzer) ? { failureAnalyzer: options.failureAnalyzer } : {}),
    subagentsEnabled: resolved.subagentsEnabled,
    ...(defined(options.subagentMaxTurns) ? { subagentMaxTurns: options.subagentMaxTurns } : {}),
    ...(defined(options.subagentMaxOutputChars) ? { subagentMaxOutputChars: options.subagentMaxOutputChars } : {}),
    reviewAntiGaming: resolved.reviewAntiGaming,
    ...(defined(options.allowedTools) ? { allowedTools: options.allowedTools } : {}),
    ...(defined(options.disabledTools) ? { disabledTools: options.disabledTools } : {}),
    ...(defined(options.permissionDecider) ? { permissionDecider: options.permissionDecider } : {}),
    ...(defined(options.projectInstructionsEnabled)
      ? { projectInstructionsEnabled: options.projectInstructionsEnabled }
      : {}),
    ...(defined(options.projectDocMaxBytes) ? { projectDocMaxBytes: options.projectDocMaxBytes } : {}),
    ...(defined(options.contextMode) ? { contextMode: options.contextMode } : {}),
    ...(defined(options.repoMapMaxChars) ? { repoMapMaxChars: options.repoMapMaxChars } : {}),
    validationMode: resolved.validationMode,
    finalEvidenceMode: resolved.finalEvidenceMode,
    ...(defined(options.skillsMode) ? { skillsMode: options.skillsMode } : {}),
    ...(defined(options.skillsMaxChars) ? { skillsMaxChars: options.skillsMaxChars } : {}),
    ...(defined(options.eventBus) ? { eventBus: options.eventBus } : {}),
    ...(defined(options.abortSignal) ? { abortSignal: options.abortSignal } : {})
  };
}

export async function runConfiguredAgent(
  options: RunConfiguredAgentOptions
): Promise<RunConfiguredAgentResult> {
  const eventBus = options.eventBus ?? new AgentEventBus();
  const compactionMode = options.compactionMode ?? DEFAULT_COMPACTION_MODE;
  const validationMode = options.validationMode ?? DEFAULT_VALIDATION_MODE;
  const finalEvidenceMode = options.finalEvidenceMode ?? DEFAULT_FINAL_EVIDENCE_MODE;
  const subagentsEnabled = options.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED;
  const reviewAntiGaming = options.reviewAntiGaming ?? true;
  const maxMessageHistoryChars = options.maxMessageHistoryChars ?? DEFAULT_MAX_MESSAGE_HISTORY_CHARS;
  const modelClient = options.modelClient ?? (options.modelClientFactory ?? createModelClient)(options.provider, {
    model: options.model
  });
  const compactionModelClient = options.compactionModelClient ?? (
    compactionMode === "model_sub_session" && (options.compactionModel || options.compactionProvider)
      ? (options.modelClientFactory ?? createModelClient)(options.compactionProvider ?? options.provider, {
          model: options.compactionModel
        })
      : undefined
  );
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
    ...baseRunConfig(
      { ...options, eventBus, compactionModelClient },
      modelClient,
      {
        compactionMode,
        validationMode,
        finalEvidenceMode,
        subagentsEnabled,
        reviewAntiGaming,
        maxMessageHistoryChars
      }
    ),
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
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

  const result = shouldUseAgentRunController({
    ...options,
    validationMode,
    finalEvidenceMode,
    reviewAntiGaming
  })
    ? await runAgentHarness(runConfig)
    : await runAgent(runConfig);
  return { result, eventBus, mcpServers };
}
