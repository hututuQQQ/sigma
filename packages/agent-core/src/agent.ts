import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseToolArguments, type AgentMessage, type ModelEvent, type ModelResponse, type ToolCall, type ToolDefinition } from "agent-ai";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { AgentLoopEngine, AgentStepProcessor, type AgentStepEvidence, type StructuredLoopDecision } from "./agent-loop-engine.js";
import { compactLargeText } from "./compaction.js";
import { JsonlSessionStore } from "./session/jsonl-session-store.js";
import { createSessionManager, type SessionManager } from "./session/session-manager.js";
import { createDefaultToolRegistry, filterToolRegistry } from "./tools/registry.js";
import { CompactionService } from "./context/compaction-service.js";
import { ContextManager } from "./context/context-manager.js";
import { ModelSubSessionCompactionProvider } from "./context/model-compaction-provider.js";
import { resolveModelContextLimits } from "./context/model-context-limits.js";
import { summarizeContextBudget } from "./context/token-budget.js";
import {
  formatRuntimeContextMessage,
  memoryContextBlock,
  recentDiffBlock,
  staticContextBlocks,
  type ContextAssemblyBlock
} from "./context/context-assembly.js";
import { formatProjectInstructionsBlock, loadProjectInstructions } from "./context/project-instructions.js";
import { formatRepoMapBlock, generateRepoMap } from "./context/repo-map.js";
import { DEFAULT_COMPACTION_MODE, DEFAULT_FINAL_EVIDENCE_MODE, DEFAULT_SUBAGENTS_ENABLED } from "./defaults.js";
import { formatSelectedSkills } from "./skills/format-skills.js";
import { loadAllSkills } from "./skills/load-skills.js";
import { projectHintsFromDiscovery, retrieveSkills } from "./skills/retrieve-skills.js";
import type { AgentSkill } from "./skills/types.js";
import { discoverProjects } from "./validation/project-discovery.js";
import { inferEvidenceRecord } from "./controller/evidence.js";
import { createInitialFinalGateStatus, finalGateNudge } from "./controller/final-gate.js";
import {
  createWorkflowState,
  recordToolInWorkflow,
  summarizeWorkflowState,
  workflowFailureNudge
} from "./controller/workflow-state.js";
import { classifyTaskIntent, resolveAgentLoopPolicy } from "./controller/loop-controller.js";
import { redactSecrets } from "./redaction.js";
import { createDefaultSandboxConfig } from "./sandbox.js";
import { InMemorySubagentJobManager } from "./subagents/subagent-job-manager.js";
import { ToolRuntime, type ToolRuntimeExecution } from "./tool-runtime.js";
import { changedWorkspaceFiles, listWorkspaceManifest } from "./harness/manifest.js";
import type {
  AgentEvent,
  AgentFinishReason,
  AgentRunConfig,
  AgentRunResult,
  ContextCompactionSummary,
  MemoryScope,
  SubagentRunSummary,
  SummaryJson,
  TokenTotals,
  ToolExecutionContext,
  ToolRuntimeMetadata,
  ToolRegistry,
  ToolResult,
  ContextSourceEntry,
  WorkspaceManifest
} from "./types.js";
import { addUsage, normalizeToolResult, toolAllMetadata, toolModelContent, toolModelMetadata } from "./types.js";

const DEFAULT_MAX_TURNS = 80;
const DEFAULT_MAX_WALL_TIME_SEC = 900;
const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 12000;
const DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;
const DEFAULT_REPO_MAP_MAX_CHARS = 20000;
const DEFAULT_SKILLS_MAX_CHARS = 8000;
const TOOL_ARGUMENT_HISTORY_MAX_CHARS = 4000;
const EVENT_METADATA_MAX_CHARS = 6000;

function nowIso(): string {
  return new Date().toISOString();
}

function event(
  runId: string,
  type: AgentEvent["type"],
  provider: string,
  model: string,
  metadata?: Record<string, unknown>,
  parentId?: string,
  sessionId?: string
): AgentEvent {
  const eventMetadata = metadata ? { ...metadata } : undefined;
  const rawThreadItem = eventMetadata?.threadItem;
  if (eventMetadata && "threadItem" in eventMetadata) delete eventMetadata.threadItem;
  return {
    id: randomUUID(),
    timestamp: nowIso(),
    type,
    runId,
    sessionId,
    parentId,
    provider,
    model,
    metadata: eventMetadata,
    ...(rawThreadItem && typeof rawThreadItem === "object" ? { threadItem: rawThreadItem as AgentEvent["threadItem"] } : {})
  };
}

function stringifyToolResult(result: ToolResult): string {
  const normalized = normalizeToolResult(result);
  return JSON.stringify({
    ok: normalized.ok,
    content: toolModelContent(normalized),
    metadata: toolModelMetadata(normalized),
    structured: normalized.structured ?? null,
    artifacts: (normalized.artifacts ?? []).filter((artifact) => artifact.model_visible === true),
    groups: (normalized.groups ?? []).filter((group) => group.modelVisible === true)
  });
}

function eventDelta(eventData: unknown): string {
  if (typeof eventData === "string") return eventData;
  if (eventData && typeof eventData === "object") {
    const data = eventData as Record<string, unknown>;
    if (typeof data.delta === "string") return data.delta;
    if (typeof data.contentDelta === "string") return data.contentDelta;
    if (typeof data.reasoningDelta === "string") return data.reasoningDelta;
  }
  return "";
}

function eventToolCall(eventData: unknown): ToolCall | null {
  if (!eventData || typeof eventData !== "object") return null;
  const data = eventData as Record<string, unknown>;
  const raw = data.toolCall && typeof data.toolCall === "object" ? data.toolCall as Record<string, unknown> : data;
  const fn = raw.function && typeof raw.function === "object" ? raw.function as Record<string, unknown> : {};
  const name = typeof fn.name === "string" ? fn.name : typeof raw.name === "string" ? raw.name : "";
  if (!name) return null;
  return {
    id: typeof raw.id === "string" ? raw.id : `call_${String(data.index ?? 0)}`,
    type: "function",
    function: {
      name,
      arguments: parseToolArguments(fn.arguments ?? raw.arguments)
    }
  };
}

function toolArgumentsObject(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toolCallCountsAsCommand(call: ToolCall): boolean {
  if (call.function.name === "bash") return true;
  if (call.function.name !== "shell_session") return false;
  return toolArgumentsObject(call.function.arguments)?.action === "send";
}

const STEP_READ_TOOLS = new Set(["read", "read_many", "grep", "glob", "repo_query", "symbol_search", "memory", "list"]);

function stepReadIntentSignature(call: ToolCall): string | null {
  const name = call.function.name;
  if (!STEP_READ_TOOLS.has(name)) return null;
  const args = toolArgumentsObject(call.function.arguments) ?? {};
  const pathValue = typeof args.path === "string"
    ? args.path
    : typeof args.cwd === "string"
      ? args.cwd
      : Array.isArray(args.files)
        ? args.files.slice(0, 5).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(",")
        : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : "";
  return `${name}:${pathValue}:${pattern}`.slice(0, 300);
}

function compactUnknownForTrace(value: unknown, label: string, maxChars: number): unknown {
  if (typeof value === "string") {
    return compactLargeText(value, { label, maxChars }).text;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => compactUnknownForTrace(item, `${label}[${index}]`, maxChars));
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const compactLabels: Record<string, string> = {
      command: "large command",
      input: "large input",
      content: "large content",
      patch: "large patch",
      arguments: "large arguments"
    };
    const nextLabel = compactLabels[key] ?? `${label}.${key}`;
    result[key] = compactUnknownForTrace(item, nextLabel, maxChars);
  }
  return result;
}

function compactToolCallForTrace(call: ToolCall): ToolCall {
  return {
    ...call,
    function: {
      ...call.function,
      arguments: compactUnknownForTrace(call.function.arguments, `${call.function.name} arguments`, TOOL_ARGUMENT_HISTORY_MAX_CHARS)
    }
  };
}

function compactAssistantMessageForHistory(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    ...(message.content
      ? { content: compactLargeText(message.content, { label: "assistant content", maxChars: 12000 }).text }
      : {}),
    ...(message.reasoningContent
      ? { reasoningContent: compactLargeText(message.reasoningContent, { label: "assistant reasoning", maxChars: 12000 }).text }
      : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(compactToolCallForTrace) } : {})
  };
}

function compactEventForTrace(agentEvent: AgentEvent): AgentEvent {
  if (!agentEvent.metadata && !agentEvent.threadItem) return agentEvent;
  return {
    ...agentEvent,
    ...(agentEvent.metadata
      ? { metadata: compactUnknownForTrace(agentEvent.metadata, "event metadata", EVENT_METADATA_MAX_CHARS) as Record<string, unknown> }
      : {}),
    ...(agentEvent.threadItem
      ? { threadItem: compactUnknownForTrace(agentEvent.threadItem, "thread item", EVENT_METADATA_MAX_CHARS) as AgentEvent["threadItem"] }
      : {})
  };
}

async function resolveRunToolRegistry(config: AgentRunConfig): Promise<ToolRegistry> {
  if (config.toolRegistry && config.toolRegistryFactory) {
    throw new Error("Configure either toolRegistry or toolRegistryFactory, not both.");
  }
  const registry = config.toolRegistry ?? (
    config.toolRegistryFactory
      ? await config.toolRegistryFactory()
      : createDefaultToolRegistry({
        subagents: {
            enabled: config.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED,
            backgroundEnabled: config.subagentBackgroundEnabled,
            heartbeatTimeoutSec: config.subagentHeartbeatTimeoutSec,
            defaultMaxTurns: config.subagentMaxTurns,
            defaultMaxOutputChars: config.subagentMaxOutputChars
          }
        })
  );
  return filterToolRegistry(registry, {
    allowedTools: config.allowedTools,
    disabledTools: config.disabledTools,
    permissionRules: config.permissionRules
  });
}

function isSubagentRunSummary(value: unknown): value is SubagentRunSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    (record.subagent_type === "investigator" || record.subagent_type === "reviewer" || record.subagent_type === "planner") &&
    (record.status === "ok" || record.status === "error") &&
    typeof record.summary === "string"
  );
}

function isInternalRunArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith(".agent/sessions/") || normalized.startsWith(".agent/artifacts/");
}

function workspaceManifestDiff(before: WorkspaceManifest | null, after: WorkspaceManifest | null): string[] {
  if (!before || !after) return [];
  const changed = new Set(changedWorkspaceFiles(before, after));
  for (const filePath of Object.keys(before)) {
    if (!after[filePath]) changed.add(filePath);
  }
  return [...changed]
    .filter((filePath) => !isInternalRunArtifact(filePath))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function shouldSnapshotWorkspaceForCalls(calls: ToolCall[]): boolean {
  return calls.some((call) => {
    const name = call.function.name;
    return name === "bash" || name === "shell_session" || name === "service" || name === "edit" || name === "write" || name === "apply_patch";
  });
}

async function safeListWorkspaceManifest(workspacePath: string): Promise<WorkspaceManifest | null> {
  try {
    return await listWorkspaceManifest(workspacePath);
  } catch {
    return null;
  }
}

function isCompletedFinishReason(reason: AgentFinishReason): boolean {
  return reason === "assistant_stop" || reason === "completed_with_changes" || reason === "completed_no_changes_allowed";
}

export function summaryJsonFromRunResult(result: AgentRunResult): SummaryJson {
  const summary: SummaryJson = {
    ...(result.sessionId ? { session_id: result.sessionId } : {}),
    status: result.status,
    finish_reason: result.finishReason,
    turns: result.turns,
    tool_calls: result.toolCalls,
    commands_executed: result.commandsExecuted,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    cache_tokens: result.usage.cacheTokens,
    cost_usd: null,
    provider: result.provider,
    model: result.model,
    duration_ms: result.durationMs,
    last_error: result.lastError
  };
  if (result.finalMessage) {
    summary.final_message = result.finalMessage;
  }
  if (result.harness) {
    summary.harness = result.harness;
  }
  if (result.toolsAvailable && result.toolsAvailable.length > 0) {
    summary.tools_available = result.toolsAvailable;
  }
  if (result.changedFiles && result.changedFiles.length > 0) {
    summary.changed_files = result.changedFiles;
  }
  if (result.todoItems && result.todoItems.length > 0) {
    summary.todo_items = result.todoItems;
  }
  if (result.projectInstructionSources && result.projectInstructionSources.length > 0) {
    summary.project_instruction_sources = result.projectInstructionSources;
  }
  if (result.contextMode) {
    summary.context_mode = result.contextMode;
  }
  if (typeof result.repoMapChars === "number") {
    summary.repo_map_chars = result.repoMapChars;
  }
  if (result.mcpServers && result.mcpServers.length > 0) {
    summary.mcp_servers = result.mcpServers;
  }
  if (result.workflow) {
    summary.workflow = result.workflow;
  }
  if (result.evidenceRecords && result.evidenceRecords.length > 0) {
    summary.evidence = result.evidenceRecords;
  }
  if (result.finalGate) {
    summary.final_gate = result.finalGate;
  }
  if (result.selectedSkills && result.selectedSkills.length > 0) {
    summary.selected_skills = result.selectedSkills;
  }
  if (result.contextCompactions && result.contextCompactions.length > 0) {
    summary.context_compactions = result.contextCompactions;
  }
  if (result.loopDiagnostics) {
    summary.loop_diagnostics = result.loopDiagnostics;
  }
  if (result.loopPhaseHistory && result.loopPhaseHistory.length > 0) {
    summary.loop_phase_history = result.loopPhaseHistory;
  }
  if (result.stepOutcomes && result.stepOutcomes.length > 0) {
    summary.step_outcomes = result.stepOutcomes;
  }
  if (result.transitionReasons && result.transitionReasons.length > 0) {
    summary.transition_reasons = result.transitionReasons;
  }
  if (result.mutationEvidence && result.mutationEvidence.length > 0) {
    summary.mutation_evidence = result.mutationEvidence;
  }
  if (result.protocolRepairs && result.protocolRepairs.length > 0) {
    summary.protocol_repairs = result.protocolRepairs;
  }
  if (result.failureAnalyses && result.failureAnalyses.length > 0) {
    summary.failure_analyses = result.failureAnalyses;
  }
  if (result.validationPlan) {
    summary.validation_plan = result.validationPlan;
  }
  if (result.codeIndex) {
    summary.code_index = result.codeIndex;
  }
  if (result.subagentRuns && result.subagentRuns.length > 0) {
    summary.subagent_runs = result.subagentRuns;
  }
  if (result.reviewFindings && result.reviewFindings.length > 0) {
    summary.review_findings = result.reviewFindings;
  }
  if (result.toolRuntime) {
    summary.tool_runtime = result.toolRuntime;
  }
  if (result.contextBudget) {
    summary.context_budget = result.contextBudget;
  }
  return summary;
}

export async function writeRunSummary(result: AgentRunResult, summaryJsonPath: string): Promise<void> {
  const resolved = path.resolve(summaryJsonPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(redactSecrets(summaryJsonFromRunResult(result)), null, 2)}\n`, "utf8");
}

export async function runAgent(config: AgentRunConfig): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const provider = config.modelClient.provider;
  const model = config.modelClient.model;
  const loopPolicy = resolveAgentLoopPolicy({ maxTurns: config.maxTurns, override: config.loopPolicy });
  const maxTurns = loopPolicy.maxProviderTurns;
  const maxWallTimeSec = config.maxWallTimeSec ?? DEFAULT_MAX_WALL_TIME_SEC;
  const compactionMode = config.compactionMode ?? DEFAULT_COMPACTION_MODE;
  const subagentsEnabled = config.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED;
  const modelContext = resolveModelContextLimits({
    configuredMaxMessageHistoryChars: config.maxMessageHistoryChars,
    limits: config.modelContextLimits
  });
  const effectiveMaxMessageHistoryChars = modelContext.effectiveMaxMessageHistoryChars ?? config.maxMessageHistoryChars;
  const memoryScopes: MemoryScope[] = config.memoryScopes ?? ["user", "feedback", "project", "reference"];
  const loopEngine = new AgentLoopEngine({ loopGuardMode: config.loopGuardMode ?? "stop" });
  const subagentJobManager = new InMemorySubagentJobManager();
  const context: ToolExecutionContext = {
    workspacePath: path.resolve(config.workspacePath),
    permissionMode: config.permissionMode ?? "ask",
    commandTimeoutSec: config.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
    maxToolOutputChars: config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    ...(config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {}),
    ...(config.toolArtifactRootDir !== undefined ? { toolArtifactRootDir: config.toolArtifactRootDir } : {}),
    permissionDecider: config.permissionDecider,
    runState: {
      todos: [],
      nextTodoId: 1,
      changedFiles: new Set<string>(),
      mutationEvidence: [],
      readFileState: new Map(),
      contextIndexes: new Map<string, unknown>(),
      subagentRuns: []
    },
    alwaysAllowTools: new Set<string>(),
    modelClient: config.modelClient,
    runId,
    provider,
    model,
    subagentsEnabled,
    subagentBackgroundEnabled: config.subagentBackgroundEnabled ?? true,
    subagentHeartbeatTimeoutSec: config.subagentHeartbeatTimeoutSec,
    subagentJobManager,
    permissionRules: config.permissionRules,
    memoryScopes,
    subagentDepth: 0,
    execPolicy: config.execPolicy,
    sandbox: config.sandbox ?? createDefaultSandboxConfig(),
    sandboxAdapter: config.sandboxAdapter,
    ...(config.abortSignal ? { abortSignal: config.abortSignal } : {})
  };
  const traceStore = config.traceJsonlPath ? new JsonlSessionStore(config.traceJsonlPath) : undefined;
  const sessionStore = config.sessionJsonlPath ? new JsonlSessionStore(config.sessionJsonlPath) : undefined;
  const durableSession: SessionManager | null = config.durableSession === false
    ? null
    : await createSessionManager({
        sessionId: config.sessionId,
        runId,
        instruction: config.instruction,
        workspacePath: context.workspacePath,
        provider,
        model,
        sessionRootDir: config.sessionRootDir,
        traceJsonlPath: config.traceJsonlPath,
        sessionJsonlPath: config.sessionJsonlPath,
        summaryJsonPath: config.summaryJsonPath,
        parentSessionId: config.parentSessionId,
        forkedFromSessionId: config.forkedFromSessionId
  });
  const workflow = createWorkflowState();
  const stepProcessor = new AgentStepProcessor({
    intent: classifyTaskIntent(config.instruction),
    policy: loopPolicy
  });
  const finalEvidenceMode = config.finalEvidenceMode ?? DEFAULT_FINAL_EVIDENCE_MODE;
  let finalGateStatus = createInitialFinalGateStatus(finalEvidenceMode);
  let finalGateAlreadyNudged = false;
  const contextCompactions: ContextCompactionSummary[] = [];
  const subagentRuns: SubagentRunSummary[] = [];
  const recordSubagentRun = (report: SubagentRunSummary): void => {
    const key = report.job_id ?? report.id;
    const exists = (item: SubagentRunSummary) => (item.job_id ?? item.id) === key;
    if (!subagentRuns.some(exists)) subagentRuns.push(report);
    context.runState.subagentRuns = [...(context.runState.subagentRuns ?? []).filter((item) => !exists(item)), report];
  };

  const recordEvent = async (agentEvent: AgentEvent): Promise<void> => {
    const safeEvent = compactEventForTrace(redactSecrets(agentEvent));
    config.eventBus?.emit(safeEvent);
    await traceStore?.append(safeEvent);
    if (config.sessionJsonlPath !== config.traceJsonlPath) {
      await sessionStore?.append(safeEvent);
    }
    await durableSession?.appendEvent(safeEvent);
  };
  context.emitEvent = recordEvent;
  if (durableSession?.sessionId) context.sessionId = durableSession.sessionId;

  const compactionService = config.compactionService ?? new CompactionService({
    mode: compactionMode,
    fallback: config.compactionFallback,
    modelProvider: compactionMode === "model_sub_session"
      ? new ModelSubSessionCompactionProvider({
          modelClient: config.compactionModelClient ?? config.modelClient,
          maxInputChars: config.compactionMaxInputChars,
          maxOutputChars: config.compactionMaxOutputChars,
          timeoutSec: config.compactionTimeoutSec,
          abortSignal: config.abortSignal
        })
      : undefined
  });
  const contextManager = config.contextManager ?? (
    config.contextManagerFactory
      ? await config.contextManagerFactory({ config, compactionService })
      : new ContextManager({ compactionService })
  );

  const requestModel = async (
    turn: number,
    requestMessages: AgentMessage[],
    tools: ToolDefinition[],
    sourceEntries: ContextSourceEntry[] = []
  ): Promise<ModelResponse> => {
    const toolChoice = tools.length === 0 ? "none" : "auto";
    const cacheHints = sourceEntries
      .filter((entry) => entry.cacheable && entry.cache_key)
      .map((entry) => ({ key: entry.cache_key as string, kind: entry.kind, label: entry.label }));
    if (!config.modelClient.stream) {
      return await config.modelClient.complete({
        messages: requestMessages,
        tools,
        toolChoice,
        metadata: { sigma_turn: String(turn) },
        cacheHints,
        abortSignal: config.abortSignal
      });
    }

    let content = "";
    let reasoningContent = "";
    let usage: ModelResponse["usage"];
    let rawDoneMessage: ModelResponse | null = null;
    const toolCallsById = new Map<string, ToolCall>();
    try {
      for await (const modelEvent of config.modelClient.stream({
        messages: requestMessages,
        tools,
        toolChoice,
        metadata: { sigma_turn: String(turn) },
        cacheHints,
        abortSignal: config.abortSignal
      })) {
        if (config.abortSignal?.aborted) {
          throw new Error("Run cancelled during model stream.");
        }
        if (modelEvent.type === "message_delta") {
          const delta = eventDelta(modelEvent.data);
          if (!delta) continue;
          content += delta;
          await recordEvent(event(runId, "assistant_delta", provider, model, { turn, delta, content }, undefined, durableSession?.sessionId));
          continue;
        }
        if (modelEvent.type === "reasoning_delta") {
          const delta = eventDelta(modelEvent.data);
          if (!delta) continue;
          reasoningContent += delta;
          await recordEvent(event(runId, "reasoning_delta", provider, model, { turn, delta, reasoningContent }, undefined, durableSession?.sessionId));
          continue;
        }
        if (modelEvent.type === "tool_call_delta") {
          const toolCall = eventToolCall(modelEvent.data);
          if (toolCall) toolCallsById.set(toolCall.id, toolCall);
          await recordEvent(event(runId, "tool_call_delta", provider, model, { turn, data: modelEvent.data }, undefined, durableSession?.sessionId));
          continue;
        }
        if (modelEvent.type === "usage") {
          usage = modelEvent.data && typeof modelEvent.data === "object" ? modelEvent.data as ModelResponse["usage"] : usage;
          continue;
        }
        if (modelEvent.type === "error") {
          const message = modelEvent.data && typeof modelEvent.data === "object"
            ? String((modelEvent.data as Record<string, unknown>).message ?? "model stream failed")
            : String(modelEvent.data ?? "model stream failed");
          throw new Error(message);
        }
        if (modelEvent.type === "done" && modelEvent.data && typeof modelEvent.data === "object") {
          rawDoneMessage = modelEvent.data as ModelResponse;
        }
      }
    } catch (error) {
      if (config.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error("Run cancelled during model stream.");
      }
      throw error;
    }

    if (rawDoneMessage?.message) return rawDoneMessage;
    const toolCalls = [...toolCallsById.values()];
    return {
      message: {
        role: "assistant",
        ...(content ? { content } : {}),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {})
      },
      usage
    };
  };

  const usage: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
  const loadedProjectInstructions = await loadProjectInstructions({
    workspacePath: context.workspacePath,
    enabled: config.projectInstructionsEnabled !== false,
    maxBytes: config.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES
  });
  const repoMap = config.contextMode === "repo-map"
    ? await generateRepoMap({
        workspacePath: context.workspacePath,
        maxChars: config.repoMapMaxChars ?? DEFAULT_REPO_MAP_MAX_CHARS
      })
    : null;
  const registry = await resolveRunToolRegistry(config);
  const toolsAvailable = registry.definitions.map((definition) => definition.function.name).sort((a, b) => a.localeCompare(b, "en"));
  const projectInstructionsBlock = formatProjectInstructionsBlock(loadedProjectInstructions);
  const repoMapBlock = repoMap ? formatRepoMapBlock(repoMap) : "";
  let selectedSkills: AgentSkill[] = [];
  let skillsBlock = "";
  if ((config.skillsMode ?? "auto") === "auto") {
    const discovery = await discoverProjects({ workspacePath: context.workspacePath });
    const allSkills = await loadAllSkills(context.workspacePath);
    selectedSkills = retrieveSkills(allSkills, {
      instruction: config.instruction,
      projectHints: projectHintsFromDiscovery(discovery)
    });
    skillsBlock = formatSelectedSkills(selectedSkills, config.skillsMaxChars ?? DEFAULT_SKILLS_MAX_CHARS);
  }
  const staticBlocks = staticContextBlocks({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    projectInstructions: projectInstructionsBlock,
    repoMap: repoMapBlock,
    skills: skillsBlock,
    tools: registry.definitions
  });
  const staticSourceEntries = staticBlocks.map((item) => item.source);
  const systemSections = staticBlocks
    .filter((item) => item.id !== "tool_definitions_static")
    .map((item) => item.content);
  const messages: AgentMessage[] = [
    { role: "system", content: systemSections.join("\n\n") },
    { role: "user", content: config.instruction }
  ];
  const activeToolDefinitions = (): ToolDefinition[] => {
    const policy = stepProcessor.toolPolicy();
    if (policy.toolsDisabled) return [];
    if (policy.disabledTools.size === 0) return registry.definitions;
    return registry.definitions.filter((definition) => !policy.disabledTools.has(definition.function.name));
  };
  const recordLoopDecision = async (decision: StructuredLoopDecision, turn: number, turnId: string): Promise<void> => {
    if (decision.action === "none") return;
    const metadata = {
      turn,
      turnId,
      action: decision.action,
      mode: stepProcessor.diagnostics().mode,
      phase: decision.phase,
      outcome: decision.outcome,
      reason: decision.reason,
      message: decision.message,
      diagnostics: stepProcessor.diagnostics()
    };
    await recordEvent(event(
      runId,
      decision.action === "stop" ? "loop_control_stop" : "loop_control_steer",
      provider,
      model,
      metadata,
      undefined,
      durableSession?.sessionId
    ));
  };
  const toolRuntime = new ToolRuntime(registry, context);
  let turns = 0;
  let toolCalls = 0;
  let commandsExecuted = 0;
  let finishReason: AgentFinishReason = "assistant_stop";
  let lastError: string | null = null;
  let finalMessage: string | undefined;
  let stoppedByAssistant = false;
  let lastContextBudget = summarizeContextBudget({
    messages,
    tools: registry.definitions,
    maxMessageHistoryChars: effectiveMaxMessageHistoryChars,
    modelContextChars: modelContext.modelContextChars,
    repoMapChars: repoMap?.chars,
    skillsChars: skillsBlock.length || undefined,
    sourceEntries: staticSourceEntries
  });

  await recordEvent(
    event(runId, "run_start", provider, model, {
      sessionId: durableSession?.sessionId,
      parentSessionId: config.parentSessionId,
      forkedFromSessionId: config.forkedFromSessionId,
      workspacePath: context.workspacePath,
      maxTurns,
      maxWallTimeSec,
      permissionMode: context.permissionMode,
      toolsAvailable,
      ...(config.permissionRules && config.permissionRules.length > 0 ? { permissionRules: config.permissionRules.length } : {}),
      ...(modelContext.modelContextChars ? { modelContextChars: modelContext.modelContextChars } : {}),
      projectInstructionSources: loadedProjectInstructions.sources,
      contextMode: config.contextMode,
      repoMapChars: repoMap?.chars,
      compactionMode,
      compactionModel: config.compactionModel,
        selectedSkills: selectedSkills.map((skill) => ({ name: skill.name, source: skill.source }))
    }, undefined, durableSession?.sessionId)
  );
  if (config.permissionRules && config.permissionRules.length > 0) {
    await recordEvent(event(
      runId,
      "permission_catalog_updated",
      provider,
      model,
      { toolsAvailable, ruleCount: config.permissionRules.length },
      undefined,
      durableSession?.sessionId
    ));
  }

  try {
    while (turns < maxTurns) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec >= maxWallTimeSec) {
        const decision = stepProcessor.observeBudgetStop(
          turns,
          "max_wall_time",
          "Structured loop stopped: max wall time reached before starting another model turn."
        );
        await recordLoopDecision(decision, turns, `${runId}:turn:${turns + 1}:preflight`);
        finishReason = "max_wall_time";
        lastError = decision.message ?? "Structured loop stopped: max wall time reached.";
        finalMessage = decision.message ?? finalMessage;
        break;
      }

      turns += 1;
      const queued = loopEngine.drainQueuedMessages(messages);
      if (queued.stopReason) {
        finishReason = "cancelled";
        lastError = queued.stopReason;
        await recordEvent(event(runId, "run_abort", provider, model, { turn: turns, reason: queued.stopReason }, undefined, durableSession?.sessionId));
        break;
      }
      const turnId = `${runId}:turn:${turns}`;
      await recordEvent(event(runId, "turn_start", provider, model, { turn: turns, turnId }, undefined, durableSession?.sessionId));
      const toolPolicy = stepProcessor.toolPolicy();
      const toolsForTurn = activeToolDefinitions();
      const loopDiagnosticsForPolicy = stepProcessor.diagnostics();
      if (loopDiagnosticsForPolicy.mode !== "normal" || toolPolicy.toolsDisabled || toolPolicy.disabledTools.size > 0) {
        await recordEvent(event(
          runId,
          "loop_control_tool_policy",
          provider,
          model,
          {
            turn: turns,
            turnId,
            mode: loopDiagnosticsForPolicy.mode,
            phase: toolPolicy.phase,
            toolsDisabled: toolPolicy.toolsDisabled,
            disabledTools: [...toolPolicy.disabledTools].sort((a, b) => a.localeCompare(b, "en")),
            reason: toolPolicy.reason
          },
          undefined,
          durableSession?.sessionId
        ));
      }
      const changedFilesForContext = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
      const preparedMessages = await contextManager.prepareMessages({
        messages,
        maxMessageHistoryChars: effectiveMaxMessageHistoryChars,
        messageHistoryRetain: config.messageHistoryRetain,
        compactionSummaryChars: config.compactionSummaryChars,
        objective: config.instruction,
        workflow: summarizeWorkflowState(workflow, changedFilesForContext),
        evidenceRecords: workflow.evidenceRecords,
        changedFiles: changedFilesForContext,
        todos: context.runState.todos,
        loopDiagnostics: stepProcessor.diagnostics(),
        mutationEvidence: stepProcessor.mutationEvidence.all(),
        emitEvent: async (contextEvent) => {
          await recordEvent(event(
            runId,
            contextEvent.type,
            provider,
            model,
            {
              ...(contextEvent.metadata as unknown as Record<string, unknown>),
              ...modelContext,
              effective_max_message_history_chars: effectiveMaxMessageHistoryChars
            },
            undefined,
            durableSession?.sessionId
          ));
          if (contextEvent.type === "context_compaction_end" || !contextEvent.metadata.fallback_used) {
            if (contextEvent.type !== "context_compaction_start") {
              contextCompactions.push(contextEvent.metadata);
            }
          }
        }
      });
      if (preparedMessages.messages !== messages) {
        messages.splice(0, messages.length, ...preparedMessages.messages);
      }
      if (preparedMessages.compacted && preparedMessages.artifact) {
        const decision = stepProcessor.observeCompaction(turns, preparedMessages.artifact.next_actions);
        if (decision.message) {
          messages.push({ role: "user", content: decision.message });
          await recordLoopDecision(decision, turns, turnId);
        }
      }
      const dynamicBlocks = (
        await Promise.all([
          recentDiffBlock(context.workspacePath),
          memoryContextBlock({
            workspacePath: context.workspacePath,
            query: [config.instruction, changedFilesForContext.join(" ")].filter(Boolean).join("\n"),
            maxItems: 5,
            maxChars: 6000,
            scopes: memoryScopes
          })
        ])
      ).filter((item): item is ContextAssemblyBlock => Boolean(item));
      const dynamicSourceEntries: ContextSourceEntry[] = dynamicBlocks.map((item) => item.source);
      const runtimeContextMessage: AgentMessage | null = dynamicBlocks.length > 0
        ? {
            role: "system",
            content: formatRuntimeContextMessage(dynamicBlocks)
          }
        : null;
      const requestMessages = runtimeContextMessage ? [...messages, runtimeContextMessage] : messages;
      lastContextBudget = summarizeContextBudget({
        messages: requestMessages,
        tools: toolsForTurn,
        maxMessageHistoryChars: effectiveMaxMessageHistoryChars,
        modelContextChars: modelContext.modelContextChars,
        repoMapChars: repoMap?.chars,
        skillsChars: skillsBlock.length || undefined,
        sourceEntries: [...staticSourceEntries, ...dynamicSourceEntries]
      });
      await recordEvent(event(runId, "context_budget", provider, model, { turn: turns, turnId, budget: lastContextBudget }, undefined, durableSession?.sessionId));
      if (config.abortSignal?.aborted) {
        finishReason = "cancelled";
        lastError = "Run cancelled before model request.";
        await recordEvent(event(runId, "run_abort", provider, model, { turn: turns }, undefined, durableSession?.sessionId));
        break;
      }

      await recordEvent(event(runId, "model_start", provider, model, { turn: turns }, undefined, durableSession?.sessionId));
      const response = await requestModel(turns, requestMessages, toolsForTurn, [...staticSourceEntries, ...dynamicSourceEntries]);
      addUsage(usage, response.usage);
      await recordEvent(event(runId, "model_end", provider, model, { turn: turns, usage: response.usage }, undefined, durableSession?.sessionId));
      if (response.usage) {
        await recordEvent(event(runId, "usage", provider, model, { turn: turns, usage: response.usage }, undefined, durableSession?.sessionId));
      }

      messages.push(compactAssistantMessageForHistory(response.message));
      finalMessage = response.message.content;
      await recordEvent(
        event(runId, "assistant_message", provider, model, {
          turn: turns,
          content: response.message.content,
          reasoningContent: response.message.reasoningContent,
          toolCalls: response.message.toolCalls?.map(compactToolCallForTrace)
        }, undefined, durableSession?.sessionId)
      );

      const calls = response.message.toolCalls ?? [];
      if (calls.length === 0) {
        const changedFiles = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
        const controllerDecision = stepProcessor.observeTerminalCandidate({
          turn: turns,
          content: response.message.content,
          changedFiles
        });
        const completedTerminal = controllerDecision.action === "stop" &&
          isCompletedFinishReason(controllerDecision.finishReason ?? "assistant_stop");
        if (controllerDecision.action === "stop" && !completedTerminal) {
          await recordLoopDecision(controllerDecision, turns, turnId);
          workflow.phase = "final";
          finishReason = controllerDecision.finishReason ?? "assistant_stop";
          lastError = controllerDecision.message ?? controllerDecision.reason ?? "Stopped by structured loop.";
          if (controllerDecision.message) {
            finalMessage = controllerDecision.message;
          }
          break;
        }
        if (controllerDecision.message) {
          messages.push({ role: "user", content: controllerDecision.message });
          await recordLoopDecision(controllerDecision, turns, turnId);
          continue;
        }
        const workflowSummary = summarizeWorkflowState(workflow, changedFiles);
        const gate = finalGateNudge({
          mode: finalEvidenceMode,
          alreadyNudged: finalGateAlreadyNudged,
          instruction: config.instruction,
          workflow: workflowSummary,
          evidenceRecords: workflow.evidenceRecords,
          turns,
          maxTurns
        });
        finalGateStatus = gate.status;
        if (gate.message) {
          finalGateAlreadyNudged = true;
          messages.push({ role: "user", content: gate.message });
          continue;
        }
        workflow.phase = "final";
        finishReason = completedTerminal ? controllerDecision.finishReason ?? "assistant_stop" : "assistant_stop";
        stepProcessor.markFinal(turns, finishReason);
        stoppedByAssistant = true;
        break;
      }

      const workflowNudges: string[] = [];
      type ToolExecutionValue = { checkpointId?: string };
      const loopGuardDecision = loopEngine.loopGuard.observe(calls as ToolCall[]);
      let loopGuardStopDecision: StructuredLoopDecision | null = null;
      const shouldDenyByLoopGuard = loopGuardDecision.action === "stop" || loopGuardDecision.skipToolCalls === true;
      const loopGuardDeniedMessage = shouldDenyByLoopGuard
        ? loopGuardDecision.message ?? "Structured loop blocked repeated tool calls."
        : null;
      if (loopGuardDecision.action !== "none") {
        await recordEvent(event(
          runId,
          "loop_guard_triggered",
          provider,
          model,
          {
            turn: turns,
            turnId,
            action: loopGuardDecision.action,
            streak: loopGuardDecision.streak,
            signature: loopGuardDecision.signature,
            signaturePreview: loopGuardDecision.signaturePreview,
            message: loopGuardDecision.message
          },
          undefined,
            durableSession?.sessionId
        ));
        const structuredDecision = stepProcessor.observeLoopGuard(
          turns,
          loopGuardDecision.message,
          loopGuardDecision.action === "stop"
        );
        if (loopGuardDecision.action === "stop") loopGuardStopDecision = structuredDecision;
        if (structuredDecision.message) workflowNudges.push(structuredDecision.message);
      }
      const changedFilesBeforeTools = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
      const manifestBeforeTools = shouldSnapshotWorkspaceForCalls(calls as ToolCall[])
        ? await safeListWorkspaceManifest(context.workspacePath)
        : null;
      const executions = await toolRuntime.executeBatch<ToolExecutionValue>(calls as ToolCall[], {
        emit: async (type, metadata, parentId) => {
          const agentEvent = event(
            runId,
            type,
            provider,
            model,
            { ...metadata, turn: turns, turnId },
            parentId,
            durableSession?.sessionId
          );
          await recordEvent(agentEvent);
          return agentEvent;
        },
        execute: async (call: ToolCall, _metadata: Required<Pick<ToolRuntimeMetadata, "readOnly" | "supportsParallel">> & ToolRuntimeMetadata) => {
          if (config.abortSignal?.aborted) {
            finishReason = "cancelled";
            lastError = "Run cancelled before tool execution.";
            await recordEvent(event(runId, "run_abort", provider, model, { turn: turns, turnId, toolName: call.function.name }, undefined, durableSession?.sessionId));
            return {
              result: { ok: false, modelContent: "Tool call cancelled before execution.", modelMetadata: { cancelled: true } },
              value: {}
            };
          }
          toolCalls += 1;
          if (toolCallCountsAsCommand(call)) {
            commandsExecuted += 1;
          }

          let result: ToolResult;
          const pendingCheckpoint = await durableSession?.checkpoints.beforeTool(call) ?? null;
          try {
            const deniedByLoopGuard = loopGuardDeniedMessage
              ? [
                  loopGuardDeniedMessage,
                  "This repeated tool call was rejected with a synthetic tool result so the tool protocol stays balanced."
                ].join("\n")
              : null;
            const deniedByController = deniedByLoopGuard ?? stepProcessor.denyToolMessage(call.function.name);
            result = deniedByController
              ? {
                  ok: false,
                  content: deniedByController,
                  metadata: {
                    loopControlDenied: true,
                    loopGuardDenied: Boolean(deniedByLoopGuard),
                    mode: stepProcessor.diagnostics().mode,
                    phase: stepProcessor.toolPolicy().phase
                  }
                }
              : await registry.execute(call, context);
          } catch (error) {
            result = {
              ok: false,
              modelContent: error instanceof Error ? error.message : String(error)
            };
          }
          const checkpoint = await durableSession?.checkpoints.afterTool(pendingCheckpoint, result) ?? null;
          return {
            result,
            value: { ...(checkpoint?.id ? { checkpointId: checkpoint.id } : {}) },
            eventMetadata: { ...(checkpoint?.id ? { checkpointId: checkpoint.id } : {}) }
          };
        }
      });

      const stepValidationEvidence: AgentStepEvidence["newValidationEvidence"] = [];
      for (const execution of executions as Array<ToolRuntimeExecution<ToolExecutionValue>>) {
        const call = execution.call;
        const result = execution.result;
        const resultMetadata = toolAllMetadata(result);
        if (resultMetadata.cacheHit === true && call.function.name === "read") {
          await recordEvent(event(
            runId,
            "read_cache_hit",
            provider,
            model,
            {
              turn: turns,
              turnId,
              toolName: call.function.name,
              path: resultMetadata.relativePath ?? resultMetadata.path,
              startLine: resultMetadata.startLine,
              limit: resultMetadata.limit,
              byteOffset: resultMetadata.byteOffset,
              byteLimit: resultMetadata.byteLimit
            },
            execution.startEventId,
            durableSession?.sessionId
          ));
        }
        if (isSubagentRunSummary(resultMetadata.subagentRun)) {
          recordSubagentRun(resultMetadata.subagentRun);
        }
        const evidence = inferEvidenceRecord({
          toolName: call.function.name,
          args: call.function.arguments,
          result
        });
        if (evidence && (evidence.executable || evidence.kind === "manual-check" || evidence.kind === "service")) {
          stepValidationEvidence.push(evidence);
        }
        const failureAnalysisStart = workflow.failureAnalyses.length;
        const failurePattern = recordToolInWorkflow({
          workflow,
          toolName: call.function.name,
          args: call.function.arguments,
          result,
          evidence,
          failureAnalyzer: config.failureAnalyzer
        });
        const failureAnalysis = workflow.failureAnalyses.length > failureAnalysisStart
          ? workflow.failureAnalyses[workflow.failureAnalyses.length - 1]
          : null;
        if (failureAnalysis) {
          await recordEvent(event(
            runId,
            "failure_analysis",
            provider,
            model,
            { turn: turns, turnId, toolName: call.function.name, analysis: failureAnalysis },
            execution.startEventId,
            durableSession?.sessionId
          ));
        }
        const nudge = workflowFailureNudge(workflow, failurePattern);
        if (nudge) workflowNudges.push(nudge);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.function.name,
          content: stringifyToolResult(result)
        });
        if (config.abortSignal?.aborted) {
          finishReason = "cancelled";
          lastError = "Run cancelled during tool execution.";
          await recordEvent(event(runId, "run_abort", provider, model, { turn: turns, turnId, toolName: call.function.name }, undefined, durableSession?.sessionId));
          break;
        }
      }
      if (workflowNudges.length > 0 && finishReason !== "cancelled") {
        messages.push({ role: "user", content: [...new Set(workflowNudges)].join("\n\n") });
      }
      const manifestAfterTools = manifestBeforeTools ? await safeListWorkspaceManifest(context.workspacePath) : null;
      const workspaceDiffFiles = workspaceManifestDiff(manifestBeforeTools, manifestAfterTools);
      for (const filePath of workspaceDiffFiles) {
        context.runState.changedFiles.add(filePath);
      }
      const changedFilesAfterTools = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
      const newMutationEvidence = stepProcessor.observeMutationEvidence(
        (executions as Array<ToolRuntimeExecution<ToolExecutionValue>>).map((execution) => ({
          call: execution.call,
          result: execution.result
        })),
        workspaceDiffFiles
      );
      if (context.runState.mutationEvidence || stepProcessor.mutationEvidence.all().length > 0) {
        context.runState.mutationEvidence = stepProcessor.mutationEvidence.all();
      }
      const changedBeforeSet = new Set(changedFilesBeforeTools);
      const stepEvidence: AgentStepEvidence = {
        newMutationEvidence,
        newWorkspaceDiffFiles: workspaceDiffFiles,
        newValidationEvidence: stepValidationEvidence,
        changedFilesDelta: changedFilesAfterTools.filter((filePath) => !changedBeforeSet.has(filePath)),
        toolNames: (calls as ToolCall[]).map((call) => call.function.name),
        readIntentSignatures: (calls as ToolCall[]).map(stepReadIntentSignature).filter((item): item is string => Boolean(item)),
        deniedToolCalls: (executions as Array<ToolRuntimeExecution<ToolExecutionValue>>)
          .filter((execution) => toolAllMetadata(execution.result).loopControlDenied === true)
          .map((execution) => execution.call.function.name)
      };
      const controllerDecision = stepProcessor.observeTurn({
        turn: turns,
        maxTurns,
        calls: calls as ToolCall[],
        results: (executions as Array<ToolRuntimeExecution<ToolExecutionValue>>).map((execution) => execution.result),
        changedFilesBefore: changedFilesBeforeTools,
        changedFilesAfter: changedFilesAfterTools,
        evidence: stepEvidence
      });
      await recordEvent(event(
        runId,
        "loop_control_state",
        provider,
        model,
        {
          turn: turns,
          turnId,
          diagnostics: stepProcessor.diagnostics()
        },
        undefined,
        durableSession?.sessionId
      ));
      if (loopGuardStopDecision) {
        await recordLoopDecision(loopGuardStopDecision, turns, turnId);
        finishReason = loopGuardStopDecision.finishReason ?? "loop_guard_repeated_tool";
        lastError = loopGuardStopDecision.message ?? "Stopped by structured loop guard.";
        finalMessage = loopGuardStopDecision.message;
        break;
      }
      if (controllerDecision.action === "stop") {
        await recordLoopDecision(controllerDecision, turns, turnId);
        finishReason = controllerDecision.finishReason ?? "max_steps";
        lastError = controllerDecision.message ?? controllerDecision.reason ?? "Stopped by structured loop.";
        finalMessage = controllerDecision.message ?? finalMessage;
        break;
      }
      if (controllerDecision.message && finishReason !== "cancelled") {
        messages.push({ role: "user", content: controllerDecision.message });
        await recordLoopDecision(controllerDecision, turns, turnId);
      }
      if (finishReason === "cancelled") break;
    }

    if (!stoppedByAssistant && turns >= maxTurns && finishReason === "assistant_stop") {
      finishReason = "max_steps";
      lastError = lastError ?? "Structured loop stopped: max step budget reached.";
    }
  } catch (error) {
    if (config.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      finishReason = "cancelled";
      lastError = error instanceof Error ? error.message : "Run cancelled.";
      await recordEvent(event(runId, "run_abort", provider, model, { message: lastError }, undefined, durableSession?.sessionId));
    } else {
      finishReason = "error";
      lastError = error instanceof Error ? error.message : String(error);
    }
    await recordEvent(event(runId, "error", provider, model, { message: lastError }, undefined, durableSession?.sessionId));
  }

  for (const job of subagentJobManager.list().filter((item) => item.status === "running")) {
    await subagentJobManager.interrupt(job.job_id, "Parent run finished before background subagent completed.");
  }
  for (const report of context.runState.subagentRuns ?? []) {
    recordSubagentRun(report);
  }

  const status = finishReason === "error" ? "error" : isCompletedFinishReason(finishReason) ? "completed" : "stopped";
  const changedFiles = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
  const result: AgentRunResult = {
    ...(durableSession?.sessionId ? { sessionId: durableSession.sessionId } : {}),
    status,
    finishReason,
    turns,
    toolCalls,
    commandsExecuted,
    usage,
    provider,
    model,
    durationMs: Date.now() - startedAt,
    lastError,
    finalMessage,
    toolsAvailable,
    changedFiles,
    todoItems: context.runState.todos,
    projectInstructionSources: loadedProjectInstructions.sources,
    contextMode: config.contextMode,
    repoMapChars: repoMap?.chars,
    codeIndex: repoMap?.codeIndex,
    mcpServers: config.mcpServers,
    workflow: summarizeWorkflowState(workflow, changedFiles),
    evidenceRecords: workflow.evidenceRecords,
    finalGate: finalGateStatus,
    selectedSkills: selectedSkills.map((skill) => ({ name: skill.name, source: skill.source })),
    contextCompactions,
    loopDiagnostics: stepProcessor.diagnostics(),
    loopPhaseHistory: stepProcessor.phaseHistory,
    stepOutcomes: stepProcessor.stepOutcomes,
    transitionReasons: stepProcessor.transitionReasons,
    mutationEvidence: stepProcessor.mutationEvidence.all(),
    protocolRepairs: stepProcessor.protocolRepairs,
    failureAnalyses: workflow.failureAnalyses,
    subagentRuns,
    toolRuntime: toolRuntime.summary(),
    contextBudget: lastContextBudget
  };

  await recordEvent(event(runId, "run_end", provider, model, { result }, undefined, durableSession?.sessionId));
  if (config.summaryJsonPath) {
    await writeRunSummary(result, config.summaryJsonPath);
  }
  await durableSession?.complete(result, summaryJsonFromRunResult(result));
  await registry.close?.();

  return result;
}
