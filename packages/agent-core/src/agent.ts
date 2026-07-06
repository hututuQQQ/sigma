import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage, ToolCall } from "agent-ai";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { JsonlSessionStore } from "./session/jsonl-session-store.js";
import { createDefaultToolRegistry } from "./tools/registry.js";
import type {
  AgentEvent,
  AgentFinishReason,
  AgentRunConfig,
  AgentRunResult,
  SummaryJson,
  TokenTotals,
  ToolExecutionContext,
  ToolResult
} from "./types.js";
import { addUsage } from "./types.js";

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_WALL_TIME_SEC = 900;
const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 12000;

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

function toSummaryJson(result: AgentRunResult): SummaryJson {
  return {
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
}

export async function writeRunSummary(result: AgentRunResult, summaryJsonPath: string): Promise<void> {
  const resolved = path.resolve(summaryJsonPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(toSummaryJson(result), null, 2)}\n`, "utf8");
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
    maxToolOutputChars: config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS
  };
  const traceStore = config.traceJsonlPath ? new JsonlSessionStore(config.traceJsonlPath) : undefined;
  const sessionStore = config.sessionJsonlPath ? new JsonlSessionStore(config.sessionJsonlPath) : undefined;

  const recordEvent = async (agentEvent: AgentEvent): Promise<void> => {
    config.eventBus?.emit(agentEvent);
    await traceStore?.append(agentEvent);
    if (config.sessionJsonlPath !== config.traceJsonlPath) {
      await sessionStore?.append(agentEvent);
    }
  };

  const usage: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
  const messages: AgentMessage[] = [
    { role: "system", content: DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: config.instruction }
  ];
  const registry = createDefaultToolRegistry();
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
      permissionMode: context.permissionMode
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
        finishReason = "assistant_stop";
        stoppedByAssistant = true;
        break;
      }

      for (const call of calls) {
        const toolStart = event(runId, "tool_start", provider, model, { toolCall: call }, undefined);
        await recordEvent(toolStart);
        toolCalls += 1;
        if (call.function.name === "bash") {
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
    finalMessage
  };

  await recordEvent(event(runId, "run_end", provider, model, { result }));
  if (config.summaryJsonPath) {
    await writeRunSummary(result, config.summaryJsonPath);
  }

  return result;
}
