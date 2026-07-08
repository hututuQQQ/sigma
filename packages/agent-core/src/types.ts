import type { ModelClient, ProviderName, ToolCall, ToolDefinition, Usage } from "agent-ai";
import type { ValidationPlan } from "./validation/validation-types.js";

export type PermissionMode = "ask" | "yolo";

export type ToolRisk = "read" | "write" | "execute" | "network" | "unknown";

export type ToolApprovalMode = "auto" | "prompt" | "deny";
export type ToolSandboxMode = "default" | "policy_only" | "bypass";

export interface ToolRuntimeMetadata {
  readOnly?: boolean;
  supportsParallel?: boolean;
  waitsForCancellation?: boolean;
  approval?: ToolApprovalMode;
  sandbox?: ToolSandboxMode;
  outputBudget?: number;
}

export interface ExecPolicyRule {
  match: string | string[];
  action: "allow" | "prompt" | "deny";
  reason?: string;
}

export interface ExecPolicyConfig {
  defaultAction?: "allow" | "prompt" | "deny";
  allowReadOnlyCommands?: boolean;
  rules?: ExecPolicyRule[];
}

export interface ExecIntentSummary {
  command: string;
  risk: ToolRisk;
  mutatesWorkspace: boolean;
  usesNetwork: boolean;
  changesGitState: boolean;
  executesCode: boolean;
  matchedRule?: string;
  action: "allow" | "prompt" | "deny";
  reason: string;
}

export interface SandboxConfig {
  mode?: "disabled" | "policy_only";
  network?: "default" | "restricted";
  filesystem?: "workspace_write" | "read_only";
}

export interface SandboxExecRequest {
  toolName: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  policy: ExecIntentSummary;
  sandbox?: SandboxConfig;
}

export interface SandboxExecDecision {
  allowed: boolean;
  reason?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
}

export interface SandboxAdapter {
  prepareExec(request: SandboxExecRequest): Promise<SandboxExecDecision>;
}

export interface PermissionRequest {
  toolName: string;
  arguments: unknown;
  risk: ToolRisk;
  reason: string;
  workspacePath: string;
}

export type PermissionDecision = "allow" | "deny" | "always_allow";

export interface PermissionDecider {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export type AgentRunStatus = "completed" | "stopped" | "error";

export type AgentFinishReason =
  | "assistant_stop"
  | "max_turns"
  | "max_wall_time"
  | "validation_failed"
  | "precheck_failed"
  | "cancelled"
  | "error";

export type AgentHarnessValidationMode = "off" | "auto";
export type AgentFinalEvidenceMode = "off" | "auto";
export type AgentSkillsMode = "off" | "auto";

export type WorkflowPhase =
  | "triage"
  | "explore"
  | "plan"
  | "implement"
  | "verify"
  | "repair"
  | "review"
  | "final";

export type WorkflowFailureCategory =
  | "compile_error"
  | "segmentation_fault"
  | "timeout"
  | "missing_tool"
  | "test_failure"
  | "unknown";

export interface WorkflowFailurePatternSummary {
  category: WorkflowFailureCategory;
  count: number;
  last_tool_name: string;
  last_command?: string;
  last_exit_code?: number | null;
  last_summary: string;
  suggested_next_action?: string;
  diagnostics?: string[];
  confidence?: number;
  related_files?: string[];
  failing_test_names?: string[];
  first_actionable_line?: string;
  rerun_command_suggestion?: string;
  should_avoid_repeating_command?: boolean;
}

export interface FailureAnalysisSummary {
  category: WorkflowFailureCategory;
  confidence: number;
  primaryMessage: string;
  relatedCommand?: string;
  relatedFiles?: string[];
  failingTestNames?: string[];
  firstActionableLine?: string;
  exitCode?: number | null;
  suggestedNextAction: string;
  diagnostics?: string[];
  rerunCommandSuggestion?: string;
  shouldAvoidRepeatingCommand?: boolean;
}

export type EvidenceKind =
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "manual-check"
  | "service"
  | "file-check"
  | "unknown";

export interface EvidenceRecord {
  kind: EvidenceKind;
  toolName: string;
  ok: boolean;
  executable: boolean;
  command?: string;
  summary?: string;
  relatedFiles?: string[];
  exitCode?: number | null;
  timestamp: string;
}

export interface FinalGateStatus {
  mode: AgentFinalEvidenceMode;
  nudged: boolean;
  status: "off" | "not-needed" | "satisfied" | "nudged" | "allowed-after-nudge" | "budget-exhausted";
  reason?: string;
}

export type SubagentType = "investigator" | "reviewer";

export interface SubagentFinding {
  title: string;
  detail: string;
  severity?: "info" | "low" | "medium" | "high";
  file?: string;
}

export interface SubagentRunSummary {
  id: string;
  subagent_type: SubagentType;
  description: string;
  status: "ok" | "error";
  summary: string;
  findings: SubagentFinding[];
  relevant_files: string[];
  validation_suggestions: string[];
  risks: string[];
  tool_calls: number;
  duration_ms: number;
  error?: string;
}

export type ReviewGateStatus = "clean" | "suspicious" | "blocked";

export interface ReviewGateFinding {
  rule_id: string;
  severity: "low" | "medium" | "high";
  message: string;
  path?: string;
  line?: number;
  snippet?: string;
}

export interface ReviewGateSummary {
  gate: "anti_gaming";
  status: ReviewGateStatus;
  findings: ReviewGateFinding[];
  suggested_fixes: string[];
  scanned_files: string[];
  duration_ms: number;
}

export interface WorkflowStateSummary {
  phase: WorkflowPhase;
  commands_tried: string[];
  changed_files: string[];
  failure_patterns?: WorkflowFailurePatternSummary[];
}

export interface SelectedSkillSummary {
  name: string;
  source: "built-in" | "workspace";
}

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
  permissionDecider?: PermissionDecider;
  runState: AgentRunState;
  alwaysAllowTools: Set<string>;
  abortSignal?: AbortSignal;
  modelClient?: ModelClient;
  emitEvent?: (event: AgentEvent) => void | Promise<void>;
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  subagentsEnabled?: boolean;
  subagentDepth?: number;
  execPolicy?: ExecPolicyConfig;
  sandbox?: SandboxConfig;
  sandboxAdapter?: SandboxAdapter;
}

export interface ToolHandler {
  (args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolHandler;
  risk?: ToolRisk;
  runtime?: ToolRuntimeMetadata;
}

export interface ToolRegistry {
  definitions: ToolDefinition[];
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
  getTool?(name: string): RegisteredTool | undefined;
  close?(): Promise<void>;
}

export interface ToolRegistryOptions {
  allowOverrides?: boolean;
  subagents?: {
    enabled?: boolean;
    defaultMaxTurns?: number;
    defaultMaxOutputChars?: number;
  };
}

export interface ToolRegistryFilter {
  allowedTools?: string[];
  disabledTools?: string[];
}

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
}

export interface AgentRunState {
  todos: TodoItem[];
  nextTodoId: number;
  changedFiles: Set<string>;
  contextIndexes?: Map<string, unknown>;
  contextIndexVersion?: number;
  toolArtifacts?: ToolArtifactSummary[];
}

export type ContextMode = "off" | "repo-map";
export type CompactionMode = "off" | "deterministic" | "model_sub_session";
export type CompactionFallbackMode = "deterministic" | "fail";

export interface McpServerRunSummary {
  name: string;
  enabled: boolean;
  transport?: "stdio" | "http";
  tools_loaded: number;
  error?: string;
}

export interface ContextCompactionSummary {
  strategy: CompactionMode;
  before_message_count: number;
  after_message_count: number;
  compacted_message_count: number;
  artifact?: unknown;
  fallback_used: boolean;
  duration_ms: number;
  error?: string;
}

export interface ContextBudgetSummary {
  estimated_tokens: number;
  message_count: number;
  tool_count: number;
  max_message_history_chars?: number;
  repo_map_chars?: number;
  skills_chars?: number;
}

export interface ToolRuntimeSummary {
  queued: number;
  started: number;
  completed: number;
  aborted: number;
  failed: number;
  parallel_batches: number;
  serial_batches: number;
  artifacts: ToolArtifactSummary[];
}

export interface ToolArtifactSummary {
  id: string;
  tool_call_id: string;
  tool_name: string;
  path: string;
  bytes: number;
  original_chars: number;
  retained_chars: number;
}

export interface CodeIndexSummary {
  file_count: number;
  symbol_count: number;
  definition_count: number;
  dependency_edge_count: number;
  test_to_source_count: number;
  config_files: string[];
  truncated: boolean;
  degraded?: boolean;
  error?: string;
}

export interface AgentRunConfig {
  instruction: string;
  workspacePath: string;
  modelClient: ModelClient;
  sessionId?: string;
  sessionRootDir?: string;
  durableSession?: boolean;
  parentSessionId?: string;
  forkedFromSessionId?: string;
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
  compactionMode?: CompactionMode;
  compactionModel?: string;
  compactionProvider?: ProviderName;
  compactionModelClient?: ModelClient;
  compactionMaxInputChars?: number;
  compactionMaxOutputChars?: number;
  compactionTimeoutSec?: number;
  compactionFallback?: CompactionFallbackMode;
  contextManager?: import("./context/context-manager.js").ContextManager;
  contextManagerFactory?: (options: {
    config: AgentRunConfig;
    compactionService?: import("./context/compaction-service.js").CompactionService;
  }) => import("./context/context-manager.js").ContextManager | Promise<import("./context/context-manager.js").ContextManager>;
  compactionService?: import("./context/compaction-service.js").CompactionService;
  failureAnalyzer?: import("./workflow/failure-analyzer.js").FailureAnalyzer;
  subagentsEnabled?: boolean;
  subagentMaxTurns?: number;
  subagentMaxOutputChars?: number;
  reviewAntiGaming?: boolean;
  eventBus?: AgentEventBusLike;
  toolRegistry?: ToolRegistry;
  toolRegistryFactory?: () => ToolRegistry | Promise<ToolRegistry>;
  allowedTools?: string[];
  disabledTools?: string[];
  permissionDecider?: PermissionDecider;
  projectInstructionsEnabled?: boolean;
  projectDocMaxBytes?: number;
  contextMode?: ContextMode;
  repoMapMaxChars?: number;
  mcpServers?: McpServerRunSummary[];
  finalEvidenceMode?: AgentFinalEvidenceMode;
  skillsMode?: AgentSkillsMode;
  skillsMaxChars?: number;
  execPolicy?: ExecPolicyConfig;
  sandbox?: SandboxConfig;
  sandboxAdapter?: SandboxAdapter;
  abortSignal?: AbortSignal;
}

export interface AgentHarnessConfig extends AgentRunConfig {
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
}

export interface AgentEventBusLike {
  emit(event: AgentEvent): void;
}

export interface AgentEvent {
  id: string;
  timestamp: string;
  type:
    | "run_start"
    | "assistant_delta"
    | "reasoning_delta"
    | "tool_call_delta"
    | "model_heartbeat"
    | "run_abort"
    | "turn_start"
    | "context_budget"
    | "model_start"
    | "model_end"
    | "assistant_message"
    | "tool_queued"
    | "tool_start"
    | "tool_progress"
    | "tool_end"
    | "tool_aborted"
    | "context_compaction_start"
    | "context_compaction_end"
    | "context_compaction_error"
    | "failure_analysis"
    | "validation_plan_created"
    | "subagent_start"
    | "subagent_end"
    | "subagent_error"
    | "review_gate_start"
    | "review_gate_end"
    | "harness_check_start"
    | "harness_check_end"
    | "usage"
    | "error"
    | "run_end";
  runId: string;
  sessionId?: string;
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
  sessionId?: string;
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
  toolsAvailable?: string[];
  changedFiles?: string[];
  todoItems?: TodoItem[];
  projectInstructionSources?: string[];
  contextMode?: ContextMode;
  repoMapChars?: number;
  mcpServers?: McpServerRunSummary[];
  workflow?: WorkflowStateSummary;
  evidenceRecords?: EvidenceRecord[];
  finalGate?: FinalGateStatus;
  selectedSkills?: SelectedSkillSummary[];
  contextCompactions?: ContextCompactionSummary[];
  failureAnalyses?: FailureAnalysisSummary[];
  validationPlan?: ValidationPlan;
  codeIndex?: CodeIndexSummary;
  subagentRuns?: SubagentRunSummary[];
  reviewFindings?: ReviewGateSummary[];
  toolRuntime?: ToolRuntimeSummary;
  contextBudget?: ContextBudgetSummary;
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
  cancelled?: boolean;
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
  managed_service_finalization?: HarnessServiceCleanupResult | null;
  post_run_cleanup: HarnessCleanupResult | null;
}

export type AgentRunControllerConfig = AgentHarnessConfig;
export type AgentRunControllerSummary = AgentHarnessSummary;
export type RunControllerCommandResult = HarnessCommandResult;
export type RunControllerRetryDecision = HarnessRetryDecision;
export type RunControllerCleanupResult = HarnessCleanupResult;
export type RunControllerServiceCleanupResult = HarnessServiceCleanupResult;

export interface SummaryJson {
  session_id?: string;
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
  harness?: AgentHarnessSummary;
  tools_available?: string[];
  changed_files?: string[];
  todo_items?: TodoItem[];
  project_instruction_sources?: string[];
  context_mode?: ContextMode;
  repo_map_chars?: number;
  mcp_servers?: McpServerRunSummary[];
  workflow?: WorkflowStateSummary;
  evidence?: EvidenceRecord[];
  final_gate?: FinalGateStatus;
  selected_skills?: SelectedSkillSummary[];
  context_compactions?: ContextCompactionSummary[];
  failure_analyses?: FailureAnalysisSummary[];
  validation_plan?: ValidationPlan;
  code_index?: CodeIndexSummary;
  subagent_runs?: SubagentRunSummary[];
  review_findings?: ReviewGateSummary[];
  tool_runtime?: ToolRuntimeSummary;
  context_budget?: ContextBudgetSummary;
}

export function addUsage(total: TokenTotals, usage: Usage | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.cacheTokens += usage.cacheTokens ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
}
