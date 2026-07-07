import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage, ToolCall } from "agent-ai";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { truncateMiddle } from "./compaction.js";
import { JsonlSessionStore } from "./session/jsonl-session-store.js";
import { createDefaultToolRegistry, filterToolRegistry } from "./tools/registry.js";
import { formatProjectInstructionsBlock, loadProjectInstructions } from "./context/project-instructions.js";
import { formatRepoMapBlock, generateRepoMap } from "./context/repo-map.js";
import { detectProjectProfile } from "./harness/project-detector.js";
import { formatSelectedSkills } from "./skills/format-skills.js";
import { loadAllSkills } from "./skills/load-skills.js";
import { projectHintsFromProfile, retrieveSkills } from "./skills/retrieve-skills.js";
import type { AgentSkill } from "./skills/types.js";
import { inferEvidenceRecord } from "./controller/evidence.js";
import { createInitialFinalGateStatus, finalGateNudge } from "./controller/final-gate.js";
import {
  createWorkflowState,
  recordToolInWorkflow,
  summarizeWorkflowState
} from "./controller/workflow-state.js";
import { redactSecrets } from "./redaction.js";
import type {
  AgentEvent,
  AgentFinishReason,
  AgentRunConfig,
  AgentRunResult,
  SummaryJson,
  TokenTotals,
  ToolExecutionContext,
  ToolRegistry,
  ToolResult
} from "./types.js";
import { addUsage } from "./types.js";

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_WALL_TIME_SEC = 900;
const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 12000;
const DEFAULT_MESSAGE_HISTORY_RETAIN = 24;
const DEFAULT_COMPACTION_SUMMARY_CHARS = 30000;
const DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;
const DEFAULT_REPO_MAP_MAX_CHARS = 20000;
const DEFAULT_SKILLS_MAX_CHARS = 8000;
const COMPACTION_MARKER = "Previous agent conversation compacted by the run controller.";

function nowIso(): string {
  return new Date().toISOString();
}

function event(
  runId: string,
  type: AgentEvent["type"],
  provider: string,
  model: string,
  metadata?: Record<string, unknown>,
  parentId?: string
): AgentEvent {
  return {
    id: randomUUID(),
    timestamp: nowIso(),
    type,
    runId,
    parentId,
    provider,
    model,
    metadata
  };
}

function stringifyToolResult(result: ToolResult): string {
  return JSON.stringify({
    ok: result.ok,
    content: result.content,
    metadata: result.metadata ?? {}
  });
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

function messageHistoryChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function compactMessageForSummary(message: AgentMessage): string {
  if (message.role === "assistant") {
    const pieces = ["assistant:"];
    if (message.reasoningContent) pieces.push(`reasoning=${truncateMiddle(message.reasoningContent, 600).text}`);
    if (message.content) pieces.push(`content=${truncateMiddle(message.content, 600).text}`);
    if (message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((call) => `${call.function.name}(${JSON.stringify(call.function.arguments)})`);
      pieces.push(`tool_calls=${truncateMiddle(calls.join("; "), 1200).text}`);
    }
    return pieces.join(" ");
  }

  if (message.role === "tool") {
    return `tool ${message.name ?? message.toolCallId}: ${truncateMiddle(message.content, 1200).text}`;
  }

  return `${message.role}: ${truncateMiddle(message.content, 1200).text}`;
}

function summarizeMessages(messages: AgentMessage[], maxChars: number): string {
  const body = messages.map(compactMessageForSummary).join("\n\n");
  return `${COMPACTION_MARKER}\n\n${truncateMiddle(body, Math.max(1, maxChars)).text}`;
}

function compactMessagesIfNeeded(
  messages: AgentMessage[],
  options: {
    maxMessageHistoryChars?: number;
    messageHistoryRetain?: number;
    compactionSummaryChars?: number;
  }
): AgentMessage[] {
  const maxChars = options.maxMessageHistoryChars;
  if (!maxChars || maxChars <= 0 || messageHistoryChars(messages) <= maxChars || messages.length <= 3) {
    return messages;
  }

  const retainCount = Math.max(0, Math.floor(options.messageHistoryRetain ?? DEFAULT_MESSAGE_HISTORY_RETAIN));
  let tailStart = Math.max(2, messages.length - retainCount);
  while (tailStart < messages.length && messages[tailStart].role === "tool") {
    tailStart += 1;
  }

  if (tailStart <= 2 || tailStart >= messages.length) {
    return messages;
  }

  const protectedMessages = messages.slice(0, 2);
  const compactedMessages = messages.slice(2, tailStart);
  const tailMessages = messages.slice(tailStart);
  const summary: AgentMessage = {
    role: "user",
    content: summarizeMessages(
      compactedMessages,
      options.compactionSummaryChars ?? DEFAULT_COMPACTION_SUMMARY_CHARS
    )
  };
  return [...protectedMessages, summary, ...tailMessages];
}

async function resolveRunToolRegistry(config: AgentRunConfig): Promise<ToolRegistry> {
  if (config.toolRegistry && config.toolRegistryFactory) {
    throw new Error("Configure either toolRegistry or toolRegistryFactory, not both.");
  }
  const registry = config.toolRegistry ?? (config.toolRegistryFactory ? await config.toolRegistryFactory() : createDefaultToolRegistry());
  return filterToolRegistry(registry, {
    allowedTools: config.allowedTools,
    disabledTools: config.disabledTools
  });
}

export function summaryJsonFromRunResult(result: AgentRunResult): SummaryJson {
  const summary: SummaryJson = {
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
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxWallTimeSec = config.maxWallTimeSec ?? DEFAULT_MAX_WALL_TIME_SEC;
  const context: ToolExecutionContext = {
    workspacePath: path.resolve(config.workspacePath),
    permissionMode: config.permissionMode ?? "ask",
    commandTimeoutSec: config.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
    maxToolOutputChars: config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    permissionDecider: config.permissionDecider,
    runState: {
      todos: [],
      nextTodoId: 1,
      changedFiles: new Set<string>()
    },
    alwaysAllowTools: new Set<string>()
  };
  const traceStore = config.traceJsonlPath ? new JsonlSessionStore(config.traceJsonlPath) : undefined;
  const sessionStore = config.sessionJsonlPath ? new JsonlSessionStore(config.sessionJsonlPath) : undefined;
  const workflow = createWorkflowState();
  const finalEvidenceMode = config.finalEvidenceMode ?? "off";
  let finalGateStatus = createInitialFinalGateStatus(finalEvidenceMode);
  let finalGateAlreadyNudged = false;

  const recordEvent = async (agentEvent: AgentEvent): Promise<void> => {
    const safeEvent = redactSecrets(agentEvent);
    config.eventBus?.emit(safeEvent);
    await traceStore?.append(safeEvent);
    if (config.sessionJsonlPath !== config.traceJsonlPath) {
      await sessionStore?.append(safeEvent);
    }
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
  const systemSections = [DEFAULT_SYSTEM_PROMPT];
  const projectInstructionsBlock = formatProjectInstructionsBlock(loadedProjectInstructions);
  if (projectInstructionsBlock) {
    systemSections.push(projectInstructionsBlock);
  }
  if (repoMap) {
    systemSections.push(formatRepoMapBlock(repoMap));
  }
  let selectedSkills: AgentSkill[] = [];
  if ((config.skillsMode ?? "auto") === "auto") {
    const profile = await detectProjectProfile(context.workspacePath);
    const allSkills = await loadAllSkills(context.workspacePath);
    selectedSkills = retrieveSkills(allSkills, {
      instruction: config.instruction,
      projectHints: projectHintsFromProfile(profile)
    });
    const skillsBlock = formatSelectedSkills(selectedSkills, config.skillsMaxChars ?? DEFAULT_SKILLS_MAX_CHARS);
    if (skillsBlock) systemSections.push(skillsBlock);
  }
  const messages: AgentMessage[] = [
    { role: "system", content: systemSections.join("\n\n") },
    { role: "user", content: config.instruction }
  ];
  const registry = await resolveRunToolRegistry(config);
  const toolsAvailable = registry.definitions.map((definition) => definition.function.name).sort((a, b) => a.localeCompare(b, "en"));
  let turns = 0;
  let toolCalls = 0;
  let commandsExecuted = 0;
  let finishReason: AgentFinishReason = "assistant_stop";
  let lastError: string | null = null;
  let finalMessage: string | undefined;
  let stoppedByAssistant = false;

  await recordEvent(
    event(runId, "run_start", provider, model, {
      workspacePath: context.workspacePath,
      maxTurns,
      maxWallTimeSec,
      permissionMode: context.permissionMode,
      toolsAvailable,
      projectInstructionSources: loadedProjectInstructions.sources,
      contextMode: config.contextMode,
      repoMapChars: repoMap?.chars,
      selectedSkills: selectedSkills.map((skill) => ({ name: skill.name, source: skill.source }))
    })
  );

  try {
    while (turns < maxTurns) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec >= maxWallTimeSec) {
        finishReason = "max_wall_time";
        break;
      }

      turns += 1;
      const compactedMessages = compactMessagesIfNeeded(messages, {
        maxMessageHistoryChars: config.maxMessageHistoryChars,
        messageHistoryRetain: config.messageHistoryRetain,
        compactionSummaryChars: config.compactionSummaryChars
      });
      if (compactedMessages !== messages) {
        messages.splice(0, messages.length, ...compactedMessages);
      }
      await recordEvent(event(runId, "model_start", provider, model, { turn: turns }));
      const response = await config.modelClient.complete({
        messages,
        tools: registry.definitions,
        toolChoice: "auto"
      });
      addUsage(usage, response.usage);
      await recordEvent(event(runId, "model_end", provider, model, { turn: turns, usage: response.usage }));
      if (response.usage) {
        await recordEvent(event(runId, "usage", provider, model, { turn: turns, usage: response.usage }));
      }

      messages.push(response.message);
      finalMessage = response.message.content;
      await recordEvent(
        event(runId, "assistant_message", provider, model, {
          turn: turns,
          content: response.message.content,
          reasoningContent: response.message.reasoningContent,
          toolCalls: response.message.toolCalls
        })
      );

      const calls = response.message.toolCalls ?? [];
      if (calls.length === 0) {
        const changedFiles = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
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
        finishReason = "assistant_stop";
        stoppedByAssistant = true;
        break;
      }

      for (const call of calls) {
        const toolStart = event(runId, "tool_start", provider, model, { toolCall: call }, undefined);
        await recordEvent(toolStart);
        toolCalls += 1;
        if (toolCallCountsAsCommand(call as ToolCall)) {
          commandsExecuted += 1;
        }

        let result: ToolResult;
        try {
          result = await registry.execute(call as ToolCall, context);
        } catch (error) {
          result = {
            ok: false,
            content: error instanceof Error ? error.message : String(error)
          };
        }

        await recordEvent(
          event(
            runId,
            "tool_end",
            provider,
            model,
            { toolCallId: call.id, toolName: call.function.name, result },
            toolStart.id
          )
        );
        const evidence = inferEvidenceRecord({
          toolName: call.function.name,
          args: call.function.arguments,
          result
        });
        recordToolInWorkflow({
          workflow,
          toolName: call.function.name,
          args: call.function.arguments,
          result,
          evidence
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.function.name,
          content: stringifyToolResult(result)
        });
      }
    }

    if (!stoppedByAssistant && turns >= maxTurns && finishReason === "assistant_stop") {
      finishReason = "max_turns";
    }
  } catch (error) {
    finishReason = "error";
    lastError = error instanceof Error ? error.message : String(error);
    await recordEvent(event(runId, "error", provider, model, { message: lastError }));
  }

  const status = finishReason === "error" ? "error" : finishReason === "assistant_stop" ? "completed" : "stopped";
  const changedFiles = [...context.runState.changedFiles].sort((a, b) => a.localeCompare(b, "en"));
  const result: AgentRunResult = {
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
    mcpServers: config.mcpServers,
    workflow: summarizeWorkflowState(workflow, changedFiles),
    evidenceRecords: workflow.evidenceRecords,
    finalGate: finalGateStatus,
    selectedSkills: selectedSkills.map((skill) => ({ name: skill.name, source: skill.source }))
  };

  await recordEvent(event(runId, "run_end", provider, model, { result }));
  if (config.summaryJsonPath) {
    await writeRunSummary(result, config.summaryJsonPath);
  }
  await registry.close?.();

  return result;
}
