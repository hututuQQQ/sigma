import type { ModelClient, ProviderName, ToolCall, ToolDefinition, Usage } from "agent-ai";
import type { ValidationPlan } from "./validation/validation-types.js";

export type PermissionMode = "ask" | "yolo";

export type ToolRisk = "read" | "write" | "execute" | "network" | "unknown";

export type PermissionRuleAction = "allow" | "ask" | "deny";
export type PermissionRuleEffect = PermissionRuleAction;

export interface PermissionRule {
  action?: PermissionRuleAction;
  effect?: PermissionRuleEffect;
  tool?: string | string[];
  tools?: string[];
  risk?: ToolRisk | ToolRisk[] | ToolPermissionRisk | ToolPermissionRisk[];
  resourceKind?: ToolResourceKind | ToolResourceKind[];
  path?: string | string[];
  host?: string | string[];
  command?: string | string[];
  reason?: string;
}

export type LoopGuardMode = "off" | "warn" | "stop";
export type MemoryScope = "user" | "feedback" | "project" | "reference" | "agent" | "subagent";

export interface ModelContextLimits {
  contextChars?: number;
  inputChars?: number;
  reservedOutputChars?: number;
}

export type ToolApprovalMode = "auto" | "prompt" | "deny";
export type ToolSandboxMode = "default" | "policy_only" | "bypass";
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "policy-only"
  | "external"
  | "disabled"
  | "policy_only";
export type SandboxBackend =
  | "auto"
  | "bubblewrap"
  | "seatbelt"
  | "windows"
  | "external"
  | "policy-only"
  | "policy_only";
export type SandboxNetworkMode = "default" | "restricted" | "disabled";
export type SandboxFilesystemMode = "workspace_write" | "read_only";

export interface SandboxFilesystemConfig {
  readRoots?: string[];
  writeRoots?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  tempRoot?: string;
}

export interface SandboxNetworkConfig {
  mode?: SandboxNetworkMode;
  allowedHosts?: string[];
  deniedHosts?: string[];
  allowLocalhost?: boolean;
}

export interface SandboxExternalConfig {
  command?: string;
  args?: string[];
}

export interface ToolRuntimeMetadata {
  readOnly?: boolean;
  supportsParallel?: boolean;
  waitsForCancellation?: boolean;
  cancellable?: boolean;
  longRunning?: boolean;
  progressKind?: "none" | "message" | "percent" | "stream" | "grouped";
  approval?: ToolApprovalMode;
  sandbox?: ToolSandboxMode;
  outputBudget?: number;
}

export type ToolUiRenderKind = "text" | "command" | "file_change" | "artifact" | "question" | "custom";
export type ToolProgressPhase = "queued" | "running" | "progress" | "completed" | "failed" | "aborted";
export type ToolResourceKind = "file" | "workspace" | "shell" | "network" | "mcp" | "memory" | "artifact" | "unknown";
export type ToolPermissionRisk = ToolRisk | "memory" | "artifact";

export interface ToolResourceDescriptor {
  kind: ToolResourceKind;
  path?: string;
  host?: string;
  command?: string;
  mode?: "read" | "write" | "execute" | "network";
  description?: string;
}

export interface ToolUiDescriptor {
  label?: string;
  group?: string;
  icon?: string;
  renderKind?: ToolUiRenderKind;
  order?: number;
}

export interface ToolPermissionDescriptor {
  risk?: ToolPermissionRisk;
  approval?: ToolApprovalMode;
  sandbox?: ToolSandboxMode;
  resources?: ToolResourceDescriptor[];
  reason?: string;
}

export interface ToolResultDescriptor {
  outputSchema?: Record<string, unknown>;
  modelProjection?: "content" | "structured" | "none";
  uiProjection?: ToolUiRenderKind;
  artifactPolicy?: "none" | "on_truncate" | "always";
  modelVisibleFields?: string[];
  privateFields?: string[];
}

export interface ToolLifecycleDescriptor {
  defer?: boolean;
  hooks?: string[];
  cancellable?: boolean;
}

export interface ToolDescriptor {
  model: ToolDefinition;
  ui?: ToolUiDescriptor;
  permission?: ToolPermissionDescriptor;
  runtime?: ToolRuntimeMetadata;
  result?: ToolResultDescriptor;
  lifecycle?: ToolLifecycleDescriptor;
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
  mode?: SandboxMode;
  backend?: SandboxBackend;
  required?: boolean;
  network?: SandboxNetworkConfig | SandboxNetworkMode;
  filesystem?: SandboxFilesystemConfig | SandboxFilesystemMode;
  external?: SandboxExternalConfig;
}

export interface SandboxExecRequest {
  toolName: string;
  command: string;
  cwd: string;
  workspacePath?: string;
  env?: NodeJS.ProcessEnv;
  policy: ExecIntentSummary;
  sandbox?: SandboxConfig;
}

export interface SandboxExecDecision {
  allowed: boolean;
  reason?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
  cleanup?: () => Promise<void> | void;
}

export interface SandboxAvailability {
  available: boolean;
  backend: string;
  mode: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxAdapter {
  checkAvailability?(sandbox: SandboxConfig | undefined, workspacePath: string): Promise<SandboxAvailability>;
  prepareExec(request: SandboxExecRequest): Promise<SandboxExecDecision>;
}

export interface PermissionRequest {
  toolName: string;
  arguments: unknown;
  risk: ToolRisk;
  reason: string;
  workspacePath: string;
  resources?: ToolResourceDescriptor[];
}

export type PermissionDecision = "allow" | "deny" | "always_allow";

export interface PermissionDecider {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export type AgentRunStatus = "completed" | "stopped" | "error";

export type AgentFinishReason =
  | "assistant_stop"
  | "completed_with_changes"
  | "completed_no_changes_allowed"
  | "blocked_no_feasible_edit"
  | "blocked_no_verification_progress"
  | "blocked_validation_failed"
  | "protocol_violation"
  | "loop_guard_repeated_tool"
  | "max_steps"
  | "compaction_failed"
  | "max_turns"
  | "max_wall_time"
  | "loop_guard"
  | "controller_stop"
  | "validation_failed"
  | "precheck_failed"
  | "cancelled"
  | "error";

export type AgentHarnessValidationMode = "off" | "auto";
export type AgentFinalEvidenceMode = "off" | "auto";
export type AgentSkillsMode = "off" | "auto";
export type AgentTaskIntent = "mutation" | "answer" | "inspect";
export type AgentLoopControlMode = "normal" | "narrow_explore" | "force_implement" | "force_final_text";
export type AgentLoopPhase = "explore" | "implement" | "verify" | "repair" | "final" | "stopped";
export type AgentStepOutcomeKind =
  | "continue"
  | "needs_follow_up"
  | "compact"
  | "terminal"
  | "blocked"
  | "protocol_error"
  | "loop_guard"
  | "max_steps";

export interface AgentLoopPhaseHistoryItem {
  turn: number;
  phase: AgentLoopPhase;
  reason?: string;
  previousPhase?: AgentLoopPhase;
  timestamp: string;
}

export interface AgentStepOutcomeSummary {
  turn: number;
  phase: AgentLoopPhase;
  outcome: AgentStepOutcomeKind;
  reason?: string;
  message?: string;
  toolNames?: string[];
  changedFiles?: string[];
  newMutationFiles?: string[];
  validationEvidence?: number;
  deniedToolCalls?: string[];
  readIntentSignatures?: string[];
  timestamp: string;
}

export interface AgentLoopTransitionReason {
  turn: number;
  from: AgentLoopPhase;
  to: AgentLoopPhase;
  reason: string;
  message?: string;
  timestamp: string;
}

export interface MutationEvidenceRecord {
  kind: "tool" | "workspace_diff";
  files: string[];
  toolName?: string;
  toolCallId?: string;
  summary?: string;
  timestamp: string;
}

export interface ProtocolRepairRecord {
  turn: number;
  phase: AgentLoopPhase;
  reason: string;
  message: string;
  attempt: number;
  timestamp: string;
}

export interface AgentLoopPolicy {
  maxProviderTurns: number;
  broadExploreLimit: number;
  readOnlyTurnLimit: number;
  noChangeTurnLimit: number;
  implementationReserveTurns: number;
  repeatedReadIntentLimit: number;
}

export interface AgentLoopDiagnostics {
  intent: AgentTaskIntent;
  mode: AgentLoopControlMode;
  phase?: AgentLoopPhase;
  stepOutcome?: AgentStepOutcomeKind;
  providerTurns: number;
  readOnlyTurns: number;
  noChangeTurns: number;
  broadReadTurns: number;
  repeatedReadIntents: number;
  mutationCount: number;
  validationCount: number;
  verifyNoProgressTurns?: number;
  postMutationNoProgressTurns?: number;
  forcedActions: string[];
  lastControllerReason?: string;
}

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

export type SubagentType = "investigator" | "reviewer" | "planner";

export interface SubagentFinding {
  title: string;
  detail: string;
  severity?: "info" | "low" | "medium" | "high";
  file?: string;
}

export interface SubagentRunSummary {
  id: string;
  job_id?: string;
  subagent_type: SubagentType;
  description: string;
  status: "ok" | "error";
  background?: boolean;
  summary: string;
  evidence?: string[];
  findings: SubagentFinding[];
  relevant_files: string[];
  validation_suggestions: string[];
  risks: string[];
  blockers?: string[];
  tool_calls: number;
  duration_ms: number;
  started_at?: string;
  finished_at?: string;
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
  modelContent?: string;
  uiContent?: string;
  structured?: unknown;
  modelMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
  artifacts?: ToolArtifactSummary[];
  groups?: ToolResultGroup[];
  actualResources?: ToolResourceDescriptor[];
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolResultGroup {
  id: string;
  title: string;
  items: unknown[];
  modelVisible?: boolean;
}

export interface ToolProgressUpdate {
  phase: ToolProgressPhase;
  message?: string;
  percent?: number;
  groupId?: string;
  data?: unknown;
}

export interface ToolArtifactInput {
  kind?: ToolArtifactSummary["kind"];
  title?: string;
  mimeType?: string;
  content: string | Uint8Array;
  extension?: string;
  modelVisible?: boolean;
  preview?: string;
}

export interface ToolExecutionContext {
  workspacePath: string;
  permissionMode: PermissionMode;
  commandTimeoutSec: number;
  maxToolOutputChars: number;
  maxParallelToolCalls?: number;
  toolArtifactRootDir?: string;
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
  declaredResources?: ToolResourceDescriptor[];
  actualResources?: ToolResourceDescriptor[];
  permissionRules?: PermissionRule[];
  subagentBackgroundEnabled?: boolean;
  subagentHeartbeatTimeoutSec?: number;
  subagentJobManager?: unknown;
  memoryScopes?: MemoryScope[];
  reportProgress?: (update: ToolProgressUpdate) => void | Promise<void>;
  createArtifact?: (artifact: ToolArtifactInput) => Promise<ToolArtifactSummary>;
  groupResult?: (group: ToolResultGroup) => void | Promise<void>;
}

export interface ToolHandler {
  (args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface RegisteredTool {
  descriptor?: ToolDescriptor;
  definition: ToolDefinition;
  execute: ToolHandler;
  risk?: ToolRisk;
  runtime?: ToolRuntimeMetadata;
}

export interface ToolRegistry {
  descriptors?: ToolDescriptor[];
  definitions: ToolDefinition[];
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
  getTool?(name: string): RegisteredTool | undefined;
  getDescriptor?(name: string): ToolDescriptor | undefined;
  close?(): Promise<void>;
}

export interface ToolRegistryOptions {
  allowOverrides?: boolean;
  subagents?: {
    enabled?: boolean;
    backgroundEnabled?: boolean;
    heartbeatTimeoutSec?: number;
    defaultMaxTurns?: number;
    defaultMaxOutputChars?: number;
  };
}

export interface ToolRegistryFilter {
  allowedTools?: string[];
  disabledTools?: string[];
  permissionRules?: PermissionRule[];
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
  mutationEvidence?: MutationEvidenceRecord[];
  readFileState?: Map<string, ReadFileState>;
  contextIndexes?: Map<string, unknown>;
  contextIndexVersion?: number;
  toolArtifacts?: ToolArtifactSummary[];
  subagentRuns?: SubagentRunSummary[];
}

export interface ReadFileState {
  path: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  startLine?: number;
  limit?: number;
  byteOffset?: number;
  byteLimit?: number;
  contentHash: string;
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
  model_context_chars?: number;
  effective_max_message_history_chars?: number;
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
  model_context_chars?: number;
  repo_map_chars?: number;
  skills_chars?: number;
  source_map?: ContextSourceMap;
  pressure?: "low" | "medium" | "high" | "critical";
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
  kind?: "text" | "json" | "patch" | "image" | "binary" | "log";
  title?: string;
  mime_type?: string;
  preview?: string;
  model_visible?: boolean;
  absolute_path?: string;
}

export type ContextSourceKind =
  | "system"
  | "project_instructions"
  | "tool_definitions"
  | "repo_map"
  | "semantic_index"
  | "diff"
  | "memory"
  | "skills"
  | "messages"
  | "compaction"
  | "validation";

export interface ContextSourceEntry {
  id: string;
  kind: ContextSourceKind;
  label: string;
  estimated_tokens: number;
  chars: number;
  cache_key?: string;
  cacheable?: boolean;
  truncated?: boolean;
  model_visible?: boolean;
  activation_reason?: string;
  path?: string;
  authority?: "system" | "project" | "tool" | "memory" | "runtime";
}

export interface ContextSourceMap {
  entries: ContextSourceEntry[];
  total_estimated_tokens: number;
  generated_at: string;
}

export type ThreadItemKind =
  | "command_execution"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "file_change"
  | "artifact"
  | "context_compaction"
  | "subagent_activity"
  | "message";

export type ThreadItemStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "info";

export interface ThreadItem {
  id: string;
  kind: ThreadItemKind;
  status: ThreadItemStatus;
  title: string;
  created_at: string;
  updated_at?: string;
  parent_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  input?: unknown;
  result?: ToolResult;
  progress?: ToolProgressUpdate;
  artifacts?: ToolArtifactSummary[];
  resources?: ToolResourceDescriptor[];
  summary?: string;
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
  maxParallelToolCalls?: number;
  toolArtifactRootDir?: string;
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
  modelContextLimits?: ModelContextLimits;
  contextManager?: import("./context/context-manager.js").ContextManager;
  contextManagerFactory?: (options: {
    config: AgentRunConfig;
    compactionService?: import("./context/compaction-service.js").CompactionService;
  }) => import("./context/context-manager.js").ContextManager | Promise<import("./context/context-manager.js").ContextManager>;
  compactionService?: import("./context/compaction-service.js").CompactionService;
  failureAnalyzer?: import("./workflow/failure-analyzer.js").FailureAnalyzer;
  subagentsEnabled?: boolean;
  subagentBackgroundEnabled?: boolean;
  subagentHeartbeatTimeoutSec?: number;
  subagentMaxTurns?: number;
  subagentMaxOutputChars?: number;
  reviewAntiGaming?: boolean;
  eventBus?: AgentEventBusLike;
  toolRegistry?: ToolRegistry;
  toolRegistryFactory?: () => ToolRegistry | Promise<ToolRegistry>;
  allowedTools?: string[];
  disabledTools?: string[];
  permissionRules?: PermissionRule[];
  loopGuardMode?: LoopGuardMode;
  memoryScopes?: MemoryScope[];
  permissionDecider?: PermissionDecider;
  projectInstructionsEnabled?: boolean;
  projectDocMaxBytes?: number;
  contextMode?: ContextMode;
  repoMapMaxChars?: number;
  mcpServers?: McpServerRunSummary[];
  finalEvidenceMode?: AgentFinalEvidenceMode;
  skillsMode?: AgentSkillsMode;
  skillsMaxChars?: number;
  loopPolicy?: Partial<AgentLoopPolicy>;
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
    | "turn_budget_nudge"
    | "loop_control_state"
    | "loop_control_steer"
    | "loop_control_tool_policy"
    | "loop_control_stop"
    | "read_cache_hit"
    | "validation_plan_created"
    | "subagent_start"
    | "subagent_end"
    | "subagent_error"
    | "subagent_job_created"
    | "subagent_progress"
    | "subagent_job_closed"
    | "loop_guard_triggered"
    | "permission_catalog_updated"
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
  threadItem?: ThreadItem;
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
  loopDiagnostics?: AgentLoopDiagnostics;
  loopPhaseHistory?: AgentLoopPhaseHistoryItem[];
  stepOutcomes?: AgentStepOutcomeSummary[];
  transitionReasons?: AgentLoopTransitionReason[];
  mutationEvidence?: MutationEvidenceRecord[];
  protocolRepairs?: ProtocolRepairRecord[];
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
  sandbox?: Record<string, unknown>;
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
  loop_diagnostics?: AgentLoopDiagnostics;
  loop_phase_history?: AgentLoopPhaseHistoryItem[];
  step_outcomes?: AgentStepOutcomeSummary[];
  transition_reasons?: AgentLoopTransitionReason[];
  mutation_evidence?: MutationEvidenceRecord[];
  protocol_repairs?: ProtocolRepairRecord[];
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

export function normalizeToolResult(result: ToolResult): ToolResult {
  const modelContent = result.modelContent ?? result.content ?? "";
  const uiContent = result.uiContent ?? result.content ?? modelContent;
  const modelMetadata = result.modelMetadata ?? result.metadata ?? {};
  return {
    ...result,
    modelContent,
    uiContent,
    modelMetadata,
    content: result.content ?? modelContent,
    metadata: result.metadata ?? modelMetadata,
    artifacts: result.artifacts ?? [],
    groups: result.groups ?? []
  };
}

export function toolModelContent(result: ToolResult): string {
  return normalizeToolResult(result).modelContent ?? "";
}

export function toolUiContent(result: ToolResult): string {
  return normalizeToolResult(result).uiContent ?? "";
}

export function toolModelMetadata(result: ToolResult): Record<string, unknown> {
  return normalizeToolResult(result).modelMetadata ?? {};
}

export function toolPrivateMetadata(result: ToolResult): Record<string, unknown> {
  return result.privateMetadata ?? {};
}

export function toolAllMetadata(result: ToolResult): Record<string, unknown> {
  return {
    ...toolModelMetadata(result),
    ...toolPrivateMetadata(result)
  };
}

export function toolDescriptorFromDefinition(
  definition: ToolDefinition,
  options: {
    risk?: ToolRisk;
    runtime?: ToolRuntimeMetadata;
    ui?: ToolUiDescriptor;
    permission?: ToolPermissionDescriptor;
    result?: ToolResultDescriptor;
    lifecycle?: ToolLifecycleDescriptor;
  } = {}
): ToolDescriptor {
  return {
    model: definition,
    runtime: options.runtime,
    ui: {
      label: definition.function.name,
      group: options.risk === "read" ? "read" : options.risk ? "action" : "tool",
      renderKind: definition.function.name === "bash" || definition.function.name === "shell_session" || definition.function.name === "service"
        ? "command"
        : "text",
      ...options.ui
    },
    permission: {
      risk: options.risk,
      approval: options.runtime?.approval,
      sandbox: options.runtime?.sandbox,
      ...options.permission
    },
    result: {
      modelProjection: "content",
      uiProjection: options.ui?.renderKind ?? "text",
      artifactPolicy: "on_truncate",
      ...options.result
    },
    lifecycle: {
      cancellable: options.runtime?.cancellable ?? options.runtime?.waitsForCancellation ?? false,
      ...options.lifecycle
    }
  };
}

export function lowerToolDescriptorForModel(descriptor: ToolDescriptor): ToolDefinition {
  return descriptor.model;
}
