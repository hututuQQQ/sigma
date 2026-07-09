import { createModelClient, type ProviderName } from "agent-ai";
import {
  AgentEventBus,
  runConfiguredAgent,
  type AgentEvent,
  type AgentFinalEvidenceMode,
  type AgentHarnessValidationMode,
  type AgentRunResult,
  type AgentSkillsMode,
  type CompactionFallbackMode,
  type CompactionMode,
  type ContextMode,
  type LoopGuardMode,
  type MemoryScope,
  type ModelContextLimits,
  type PermissionMode,
  type PermissionRule,
  type SandboxConfig
} from "agent-core";
import type { TuiPermissionController } from "./permission.js";

export interface RunSessionOptions {
  instruction: string;
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  maxTurns?: number;
  maxWallTimeSec?: number;
  commandTimeoutSec?: number;
  sandbox?: SandboxConfig;
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
  permissionRules?: PermissionRule[];
  loopGuardMode?: LoopGuardMode;
  memoryScopes?: MemoryScope[];
  contextMode?: ContextMode;
  repoMapMaxChars?: number;
  modelContextLimits?: ModelContextLimits;
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
  finalEvidenceMode?: AgentFinalEvidenceMode;
  skillsMode?: AgentSkillsMode;
  skillsMaxChars?: number;
  subagentsEnabled?: boolean;
  subagentBackgroundEnabled?: boolean;
  subagentHeartbeatTimeoutSec?: number;
  subagentMaxTurns?: number;
  subagentMaxOutputChars?: number;
  reviewAntiGaming?: boolean;
  enableMcp?: boolean;
  mcpConfig?: string;
  traceJsonlPath?: string;
  sessionJsonlPath?: string;
  summaryJsonPath?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  abortSignal?: AbortSignal;
  permissionController: TuiPermissionController;
  onEvent(event: AgentEvent): void;
}

export async function runSession(options: RunSessionOptions): Promise<AgentRunResult> {
  const eventBus = new AgentEventBus();
  const unsubscribe = eventBus.on(options.onEvent);
  const modelClient = createModelClient(options.provider, { model: options.model });

  try {
    const { result } = await runConfiguredAgent({
      instruction: options.instruction,
      workspacePath: options.workspacePath,
      provider: options.provider,
      model: options.model,
      modelClient,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
      maxWallTimeSec: options.maxWallTimeSec,
      commandTimeoutSec: options.commandTimeoutSec,
      sandbox: options.sandbox,
      validationMode: options.validationMode,
      validationCommands: options.validationCommands,
      validationRetryLimit: options.validationRetryLimit,
      validationTimeoutSec: options.validationTimeoutSec,
      precheckCommand: options.precheckCommand,
      precheckTimeoutSec: options.precheckTimeoutSec,
      postRunCleanupGlobs: options.postRunCleanupGlobs,
      harnessTimeoutSec: options.harnessTimeoutSec,
      retryMinBudgetSec: options.retryMinBudgetSec,
      attemptsDir: options.attemptsDir,
      allowedTools: options.allowedTools,
      disabledTools: options.disabledTools,
      permissionRules: options.permissionRules,
      loopGuardMode: options.loopGuardMode,
      memoryScopes: options.memoryScopes,
      contextMode: options.contextMode ?? "repo-map",
      repoMapMaxChars: options.repoMapMaxChars,
      modelContextLimits: options.modelContextLimits,
      maxMessageHistoryChars: options.maxMessageHistoryChars,
      messageHistoryRetain: options.messageHistoryRetain,
      compactionSummaryChars: options.compactionSummaryChars,
      compactionMode: options.compactionMode,
      compactionModel: options.compactionModel,
      compactionProvider: options.compactionProvider,
      compactionMaxInputChars: options.compactionMaxInputChars,
      compactionMaxOutputChars: options.compactionMaxOutputChars,
      compactionTimeoutSec: options.compactionTimeoutSec,
      compactionFallback: options.compactionFallback,
      finalEvidenceMode: options.finalEvidenceMode,
      skillsMode: options.skillsMode,
      skillsMaxChars: options.skillsMaxChars,
      subagentsEnabled: options.subagentsEnabled,
      subagentBackgroundEnabled: options.subagentBackgroundEnabled,
      subagentHeartbeatTimeoutSec: options.subagentHeartbeatTimeoutSec,
      subagentMaxTurns: options.subagentMaxTurns,
      subagentMaxOutputChars: options.subagentMaxOutputChars,
      reviewAntiGaming: options.reviewAntiGaming,
      enableMcp: options.enableMcp,
      mcpConfig: options.mcpConfig,
      traceJsonlPath: options.traceJsonlPath,
      sessionJsonlPath: options.sessionJsonlPath,
      summaryJsonPath: options.summaryJsonPath,
      parentSessionId: options.parentSessionId,
      forkedFromSessionId: options.forkedFromSessionId,
      permissionDecider: options.permissionMode === "ask" ? options.permissionController : undefined,
      eventBus,
      abortSignal: options.abortSignal
    });
    return result;
  } finally {
    unsubscribe();
  }
}
