import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelResponse, ToolCall } from "agent-ai";
import { truncateMiddle } from "../compaction.js";
import { redactSecretText, redactSecrets } from "../redaction.js";
import type {
  AgentEvent,
  SubagentFinding,
  SubagentRunSummary,
  SubagentType,
  ToolExecutionContext,
  ToolResult
} from "../types.js";
import { toolModelContent, toolModelMetadata } from "../types.js";
import { investigatorSystemPrompt } from "./investigator-agent.js";
import { reviewerSystemPrompt } from "./reviewer-agent.js";
import type { SubagentExecution, SubagentRunRequest } from "./subagent-types.js";

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;
export const READ_ONLY_SUBAGENT_TOOLS = [
  "read",
  "list",
  "glob",
  "grep",
  "repo_query",
  "symbol_search",
  "git_status",
  "git_diff"
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function subagentEvent(
  context: ToolExecutionContext,
  type: AgentEvent["type"],
  metadata: Record<string, unknown>
): AgentEvent {
  return {
    id: randomUUID(),
    timestamp: nowIso(),
    type,
    runId: context.runId ?? "subagent",
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    provider: context.provider ?? context.modelClient?.provider,
    model: context.model ?? context.modelClient?.model,
    metadata
  };
}

async function emit(context: ToolExecutionContext, type: AgentEvent["type"], metadata: Record<string, unknown>): Promise<void> {
  await context.emitEvent?.(redactSecrets(subagentEvent(context, type, metadata)));
}

function numberLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringArray(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
    if (result.length >= max) break;
  }
  return result;
}

function findingsArray(value: unknown): SubagentFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item, index) => {
    if (typeof item === "string") {
      return { title: `Finding ${index + 1}`, detail: truncateMiddle(item, 800).text };
    }
    if (!item || typeof item !== "object") {
      return { title: `Finding ${index + 1}`, detail: String(item) };
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string"
      ? record.title
      : typeof record.message === "string"
        ? record.message
        : `Finding ${index + 1}`;
    const detail = typeof record.detail === "string"
      ? record.detail
      : typeof record.body === "string"
        ? record.body
        : typeof record.message === "string"
          ? record.message
          : JSON.stringify(record);
    const severity = record.severity === "info" || record.severity === "low" || record.severity === "medium" || record.severity === "high"
      ? record.severity
      : undefined;
    return {
      title: truncateMiddle(title, 200).text,
      detail: truncateMiddle(detail, 1000).text,
      ...(severity ? { severity } : {}),
      ...(typeof record.file === "string" ? { file: record.file } : {})
    };
  });
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function reportFromAssistant(options: {
  id: string;
  request: SubagentRunRequest;
  response: ModelResponse;
  toolCalls: number;
  durationMs: number;
}): SubagentRunSummary {
  const content = options.response.message.content ?? "";
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return {
      id: options.id,
      subagent_type: options.request.subagentType,
      description: options.request.description,
      status: "ok",
      summary: truncateMiddle(content.trim() || "Subagent finished without a JSON body.", 1200).text,
      findings: [],
      relevant_files: options.request.relatedFiles ?? [],
      validation_suggestions: [],
      risks: [],
      tool_calls: options.toolCalls,
      duration_ms: options.durationMs
    };
  }
  const status = parsed.status === "error" ? "error" : "ok";
  return {
    id: options.id,
    subagent_type: options.request.subagentType,
    description: options.request.description,
    status,
    summary: truncateMiddle(String(parsed.summary ?? content.trim() ?? "Subagent finished."), 1200).text,
    findings: findingsArray(parsed.findings),
    relevant_files: stringArray(parsed.relevantFiles ?? parsed.relevant_files, 50),
    validation_suggestions: stringArray(parsed.validationSuggestions ?? parsed.validation_suggestions, 20),
    risks: stringArray(parsed.risks, 20),
    tool_calls: options.toolCalls,
    duration_ms: options.durationMs,
    ...(typeof parsed.error === "string" ? { error: truncateMiddle(parsed.error, 800).text } : {})
  };
}

function errorReport(options: {
  id: string;
  request: SubagentRunRequest;
  message: string;
  toolCalls: number;
  startedAt: number;
}): SubagentRunSummary {
  return {
    id: options.id,
    subagent_type: options.request.subagentType,
    description: options.request.description,
    status: "error",
    summary: truncateMiddle(redactSecretText(options.message), 1200).text,
    findings: [],
    relevant_files: options.request.relatedFiles ?? [],
    validation_suggestions: [],
    risks: [],
    tool_calls: options.toolCalls,
    duration_ms: Date.now() - options.startedAt,
    error: truncateMiddle(redactSecretText(options.message), 1200).text
  };
}

function systemPrompt(type: SubagentType): string {
  return type === "reviewer" ? reviewerSystemPrompt() : investigatorSystemPrompt();
}

function userPrompt(request: SubagentRunRequest): string {
  return [
    `Description: ${request.description}`,
    "",
    "Prompt:",
    request.prompt,
    "",
    `Related files: ${(request.relatedFiles ?? []).join(", ") || "(none supplied)"}`,
    "",
    "Return one JSON object only. Keep findings concise and cite file paths when possible."
  ].join("\n");
}

function toolResultMessage(call: ToolCall, result: ToolResult, maxOutputChars: number): AgentMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.function.name,
    content: JSON.stringify({
      ok: result.ok,
      content: truncateMiddle(toolModelContent(result), maxOutputChars).text,
      metadata: toolModelMetadata(result)
    })
  };
}

export async function runSubagent(execution: SubagentExecution): Promise<SubagentRunSummary> {
  const id = randomUUID();
  const startedAt = Date.now();
  const request = execution.request;
  const context = execution.context;
  let toolCalls = 0;

  if (!context.modelClient) {
    return errorReport({ id, request, message: "Subagent requires a model client in the tool execution context.", toolCalls, startedAt });
  }
  if (context.subagentDepth && context.subagentDepth > 0) {
    return errorReport({ id, request, message: "Recursive subagent calls are disabled.", toolCalls, startedAt });
  }
  if ((request as { background?: unknown }).background === true) {
    return errorReport({ id, request, message: "Background subagents are not supported yet.", toolCalls, startedAt });
  }

  const maxTurns = numberLimit(request.maxTurns, execution.options.defaultMaxTurns ?? DEFAULT_MAX_TURNS, 1, 8);
  const maxOutputChars = numberLimit(
    request.maxOutputChars,
    execution.options.defaultMaxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    1000,
    50000
  );
  const registry = execution.options.createToolRegistry(request.subagentType);
  const childContext: ToolExecutionContext = {
    workspacePath: context.workspacePath,
    permissionMode: "yolo",
    commandTimeoutSec: context.commandTimeoutSec,
    maxToolOutputChars: maxOutputChars,
    permissionDecider: undefined,
    runState: context.runState,
    alwaysAllowTools: new Set<string>(),
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    subagentsEnabled: false,
    subagentDepth: (context.subagentDepth ?? 0) + 1
  };
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt(request.subagentType) },
    { role: "user", content: userPrompt(request) }
  ];

  await emit(context, "subagent_start", {
    subagent_id: id,
    subagent_type: request.subagentType,
    description: request.description,
    max_turns: maxTurns
  });

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const response = await context.modelClient.complete({
        messages,
        tools: registry.definitions,
        toolChoice: "auto",
        abortSignal: context.abortSignal,
        metadata: { sigma_subagent: request.subagentType }
      });
      messages.push(response.message);
      const calls = response.message.toolCalls ?? [];
      if (calls.length === 0) {
        const report = reportFromAssistant({
          id,
          request,
          response,
          toolCalls,
          durationMs: Date.now() - startedAt
        });
        await emit(context, "subagent_end", { subagent_id: id, report });
        await registry.close?.();
        return report;
      }
      for (const call of calls) {
        toolCalls += 1;
        const result = await registry.execute(call, childContext);
        messages.push(toolResultMessage(call, result, maxOutputChars));
      }
    }
    const report = errorReport({
      id,
      request,
      message: `Subagent reached maxTurns=${maxTurns} before returning a final JSON report.`,
      toolCalls,
      startedAt
    });
    await emit(context, "subagent_error", { subagent_id: id, report });
    await registry.close?.();
    return report;
  } catch (error) {
    const report = errorReport({
      id,
      request,
      message: error instanceof Error ? error.message : String(error),
      toolCalls,
      startedAt
    });
    await emit(context, "subagent_error", { subagent_id: id, report });
    await registry.close?.();
    return report;
  }
}
