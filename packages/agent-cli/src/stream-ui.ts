import type { AgentEvent, AgentEventBus } from "agent-core";
import { redactSecretText, truncateMiddle } from "agent-core";

function argsObject(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toolNameFromEvent(event: AgentEvent): string {
  const toolCall = event.metadata?.toolCall as { function?: { name?: unknown } } | undefined;
  const direct = event.metadata?.toolName;
  if (typeof direct === "string") return direct;
  if (typeof toolCall?.function?.name === "string") return toolCall.function.name;
  return "unknown";
}

function toolDetailFromEvent(event: AgentEvent): string {
  const toolCall = event.metadata?.toolCall as { function?: { name?: unknown; arguments?: unknown } } | undefined;
  const name = toolNameFromEvent(event);
  const args = argsObject(toolCall?.function?.arguments);
  if (!args) return name;
  const stringArg = (key: string) => (typeof args[key] === "string" ? redactSecretText(args[key] as string) : undefined);
  const command = stringArg("command") ?? stringArg("input");
  if ((name === "bash" || name === "shell_session" || name === "service") && command) {
    return `${name} command=${truncateMiddle(command.replace(/\s+/g, " "), 160).text}`;
  }
  const path = stringArg("path") ?? stringArg("cwd") ?? stringArg("pattern") ?? stringArg("glob") ?? stringArg("query");
  if (path) return `${name} target=${truncateMiddle(path.replace(/\s+/g, " "), 120).text}`;
  return name;
}

function assistantSummary(event: AgentEvent): string {
  const content = typeof event.metadata?.content === "string" ? event.metadata.content.trim() : "";
  const toolCalls = Array.isArray(event.metadata?.toolCalls) ? event.metadata.toolCalls.length : 0;
  if (content) return truncateMiddle(redactSecretText(content.replace(/\s+/g, " ")), 120).text;
  if (toolCalls > 0) return `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
  return "(empty assistant message)";
}

function usageSummary(value: unknown): string {
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } | undefined;
  const input = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
  const output = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
  const total = typeof usage?.totalTokens === "number" ? usage.totalTokens : input + output;
  return `input=${input} output=${output} total=${total}`;
}

export function formatAgentEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "run_start":
      return `[sigma] run_start provider=${event.provider ?? "unknown"} model=${event.model ?? "unknown"}`;
    case "model_start":
      return `[sigma] model_start turn=${String(event.metadata?.turn ?? "?")}`;
    case "model_end":
      return `[sigma] model_end turn=${String(event.metadata?.turn ?? "?")} ${usageSummary(event.metadata?.usage)}`;
    case "assistant_message":
      return `[sigma] assistant ${assistantSummary(event)}`;
    case "tool_start":
      return `[sigma] tool_start ${toolDetailFromEvent(event)}`;
    case "tool_end": {
      const result = event.metadata?.result as { ok?: unknown; content?: unknown; metadata?: Record<string, unknown> } | undefined;
      const duration = typeof result?.metadata?.durationMs === "number" ? ` duration_ms=${result.metadata.durationMs}` : "";
      const tail = typeof result?.content === "string" && result.content.trim()
        ? ` ${truncateMiddle(redactSecretText(result.content.replace(/\s+/g, " ").trim()), 120).text}`
        : "";
      return `[sigma] tool_end ${toolNameFromEvent(event)} ${result?.ok === true ? "ok" : "failed"}${duration}${tail}`;
    }
    case "harness_check_start":
      return `[sigma] ${String(event.metadata?.kind ?? "check")}_start attempt=${String(event.metadata?.attempt ?? "?")} command=${truncateMiddle(redactSecretText(String(event.metadata?.command ?? "")).replace(/\s+/g, " "), 160).text}`;
    case "harness_check_end":
      return `[sigma] ${String(event.metadata?.kind ?? "check")}_end attempt=${String(event.metadata?.attempt ?? "?")} exit=${String(event.metadata?.exitCode ?? "?")} duration_ms=${String(event.metadata?.durationMs ?? "?")}`;
    case "usage":
      return `[sigma] usage turn=${String(event.metadata?.turn ?? "?")} ${usageSummary(event.metadata?.usage)}`;
    case "run_end": {
      const result = event.metadata?.result as { status?: unknown; finishReason?: unknown } | undefined;
      return `[sigma] run_end status=${String(result?.status ?? "?")} finish=${String(result?.finishReason ?? "?")}`;
    }
    case "error":
      return `[sigma] error ${redactSecretText(String(event.metadata?.message ?? "unknown"))}`;
    default:
      return null;
  }
}

export function attachStreamUi(eventBus: AgentEventBus, stderr: NodeJS.WritableStream): () => void {
  return eventBus.on((event) => {
    const line = formatAgentEvent(event);
    if (line) stderr.write(`${line}\n`);
  });
}
