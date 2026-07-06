import type { ModelClient, ToolCall, ToolDefinition, Usage } from "agent-ai";

export type PermissionMode = "ask" | "yolo";

export type AgentRunStatus = "completed" | "stopped" | "error";

export type AgentFinishReason =
  | "assistant_stop"
  | "max_turns"
  | "max_wall_time"
  | "validation_failed"
  | "precheck_failed"
  | "error";

export type AgentHarnessValidationMode = "off" | "auto";

export interface ToolResult {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  workspacePath: string;
  permissionMode: PermissionMode;
  commandTimeoutSec: number;
  maxToolOutputChars: number;
}

export interface ToolHandler {
  (args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolHandler;
}

export interface ToolRegistry {
  definitions: ToolDefinition[];
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface AgentRunConfig {
  instruction: string;
  workspacePath: string;
  modelClient: ModelClient;
  maxTurns?: number;
  maxWallTimeSec?: number;
  commandTimeoutSec?: number;
  permissionMode?: PermissionMode;
  traceJsonlPath?: string;
  sessionJsonlPath?: string;
  summaryJsonPath?: string;
  maxToolOutputChars?: number;
  maxMessageHistoryChars?: number;
  messageHistoryRetain?: number;
  compactionSummaryChars?: number;
  eventBus?: AgentEventBusLike;
}

export interface AgentHarnessConfig extends AgentRunConfig {
  validationMode?: AgentHarnessValidationMode;
  validationRetryLimit?: number;
  validationTimeoutSec?: number;
  precheckCommand?: string;
  precheckTimeoutSec?: number;
  preVerifierCleanupGlobs?: string[];
  harnessTimeoutSec?: number;
  retryMinBudgetSec?: number;
  attemptsDir?: string;
}

export interface AgentEventBusLike {
  emit(event: AgentEvent): void;
}

export interface AgentEvent {
  id: string;
  timestamp: string;
  type:
    | "run_start"
    | "model_start"
    | "model_end"
    | "assistant_message"
    | "tool_start"
    | "tool_end"
    | "usage"
    | "error"
    | "run_end";
  runId: string;
  parentId?: string;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  finishReason: AgentFinishReason;
  turns: number;
  toolCalls: number;
  commandsExecuted: number;
  usage: TokenTotals;
  provider: string;
  model: string;
  durationMs: number;
  lastError: string | null;
  finalMessage?: string;
  harness?: AgentHarnessSummary;
}

export interface WorkspaceManifestEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export type WorkspaceManifest = Record<string, WorkspaceManifestEntry>;

export interface HarnessCommandResult {
  kind: "validation" | "precheck";
  source: string;
  command: string;
  attempt: number;
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  related_files: string[];
  timeout_sec: number;
  duration_ms: number;
  timed_out?: boolean;
  settled_on?: string;
  signal?: string | null;
  message: string;
  agent_summary?: string;
  trace_tail?: string;
}

export interface HarnessRetryDecision {
  retry_number: number;
  action: "started" | "skipped";
  reason: string;
  trigger: "validation" | "precheck" | "validation+precheck" | "harness";
  remaining_harness_budget_sec: number | null;
  minimum_retry_budget_sec: number;
}

export interface HarnessCleanupResult {
  patterns: string[];
  removed: string[];
  skipped: string[];
  exit_code: number;
  warning?: string;
}

export interface HarnessServiceCleanupResult {
  stopped: string[];
  kept: string[];
  missing: string[];
  errors: string[];
}

export interface HarnessAttemptSummary {
  attempt: number;
  status: AgentRunStatus;
  finish_reason: AgentFinishReason;
  summary_path: string;
  trace_path: string;
}

export interface AgentHarnessSummary {
  attempts: HarnessAttemptSummary[];
  validation_results: HarnessCommandResult[];
  precheck_results: HarnessCommandResult[];
  retry_decisions: HarnessRetryDecision[];
  service_cleanup?: HarnessServiceCleanupResult | null;
  pre_verifier_cleanup: HarnessCleanupResult | null;
}

export interface SummaryJson {
  status: AgentRunStatus;
  finish_reason: AgentFinishReason;
  turns: number;
  tool_calls: number;
  commands_executed: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_usd: null;
  provider: string;
  model: string;
  duration_ms: number;
  last_error: string | null;
  final_message?: string;
  validation_commands?: string[];
  harness?: AgentHarnessSummary;
}

export function addUsage(total: TokenTotals, usage: Usage | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.cacheTokens += usage.cacheTokens ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
}
