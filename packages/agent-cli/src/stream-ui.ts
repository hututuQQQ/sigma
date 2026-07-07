import type { AgentEvent, AgentEventBus } from "agent-core";
import { redactSecretText, truncateMiddle } from "agent-core";

function toolNameFromEvent(event: AgentEvent): string {
  const toolCall = event.metadata?.toolCall as { function?: { name?: unknown } } | undefined;
  const direct = event.metadata?.toolName;
  if (typeof direct === "string") return direct;
  if (typeof toolCall?.function?.name === "string") return toolCall.function.name;
  return "unknown";
}

function assistantSummary(event: AgentEvent): string {
  const content = typeof event.metadata?.content === "string" ? event.metadata.content.trim() : "";
  const toolCalls = Array.isArray(event.metadata?.toolCalls) ? event.metadata.toolCalls.length : 0;
  if (content) return truncateMiddle(redactSecretText(content.replace(/\s+/g, " ")), 120).text;
  if (toolCalls > 0) return `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
  return "(empty assistant message)";
}

export function formatAgentEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "run_start":
      return `[sigma] run_start provider=${event.provider ?? "unknown"} model=${event.model ?? "unknown"}`;
    case "model_start":
      return `[sigma] model_start turn=${String(event.metadata?.turn ?? "?")}`;
    case "model_end":
      return `[sigma] model_end turn=${String(event.metadata?.turn ?? "?")}`;
    case "assistant_message":
      return `[sigma] assistant ${assistantSummary(event)}`;
    case "tool_start":
      return `[sigma] tool_start ${toolNameFromEvent(event)}`;
    case "tool_end": {
      const result = event.metadata?.result as { ok?: unknown } | undefined;
      return `[sigma] tool_end ${toolNameFromEvent(event)} ${result?.ok === true ? "ok" : "failed"}`;
    }
    case "harness_check_start":
      return `[sigma] ${String(event.metadata?.kind ?? "check")}_start attempt=${String(event.metadata?.attempt ?? "?")}`;
    case "harness_check_end":
      return `[sigma] ${String(event.metadata?.kind ?? "check")}_end exit=${String(event.metadata?.exitCode ?? "?")}`;
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
