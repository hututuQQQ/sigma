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
  if (typeof event.threadItem?.tool_name === "string") return event.threadItem.tool_name;
  const toolCall = event.metadata?.toolCall as { function?: { name?: unknown } } | undefined;
  const direct = event.metadata?.toolName;
  if (typeof direct === "string") return direct;
  if (typeof toolCall?.function?.name === "string") return toolCall.function.name;
  return "unknown";
}

function toolDetailFromEvent(event: AgentEvent): string {
  const toolCall = event.metadata?.toolCall as { function?: { name?: unknown; arguments?: unknown } } | undefined;
  const name = toolNameFromEvent(event);
  const args = argsObject(event.threadItem?.input ?? toolCall?.function?.arguments);
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

function toolResultFromEvent(event: AgentEvent): { ok?: unknown; content?: string; metadata?: Record<string, unknown> } | undefined {
  const result = event.threadItem?.result ?? event.metadata?.result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const modelMetadata = record.modelMetadata && typeof record.modelMetadata === "object" ? record.modelMetadata as Record<string, unknown> : undefined;
  const legacyMetadata = record.metadata && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : undefined;
  return {
    ok: record.ok,
    content: typeof record.uiContent === "string"
      ? record.uiContent
      : typeof record.modelContent === "string"
        ? record.modelContent
        : typeof record.content === "string"
          ? record.content
          : undefined,
    metadata: { ...(legacyMetadata ?? {}), ...(modelMetadata ?? {}) }
  };
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

function sandboxWarning(metadata: Record<string, unknown> | undefined): string {
  const sandbox = metadata?.sandbox;
  if (!sandbox || typeof sandbox !== "object") return "";
  const warning = (sandbox as Record<string, unknown>).warning;
  return typeof warning === "string" && warning
    ? ` sandbox_warning=${truncateMiddle(redactSecretText(warning.replace(/\s+/g, " ")), 140).text}`
    : "";
}

export function formatAgentEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "run_start":
      return `[sigma] run_start provider=${event.provider ?? "unknown"} model=${event.model ?? "unknown"}`;
    case "turn_start":
      return `[sigma] turn_start turn=${String(event.metadata?.turn ?? "?")}`;
    case "context_budget": {
      const budget = event.metadata?.budget as { estimated_tokens?: unknown; message_count?: unknown; tool_count?: unknown } | undefined;
      return `[sigma] context_budget turn=${String(event.metadata?.turn ?? "?")} estimated_tokens=${String(budget?.estimated_tokens ?? "?")} messages=${String(budget?.message_count ?? "?")} tools=${String(budget?.tool_count ?? "?")}`;
    }
    case "model_start":
      return `[sigma] model_start turn=${String(event.metadata?.turn ?? "?")}`;
    case "model_end":
      return `[sigma] model_end turn=${String(event.metadata?.turn ?? "?")} ${usageSummary(event.metadata?.usage)}`;
    case "assistant_message":
      return `[sigma] assistant ${assistantSummary(event)}`;
    case "tool_queued":
      return `[sigma] tool_queued ${String(event.metadata?.toolName ?? "tool")}`;
    case "tool_start":
      return `[sigma] tool_start ${toolDetailFromEvent(event)}`;
    case "tool_aborted":
      return `[sigma] tool_aborted ${String(event.metadata?.toolName ?? "tool")} reason=${truncateMiddle(redactSecretText(String(event.metadata?.reason ?? "")).replace(/\s+/g, " "), 120).text}`;
    case "tool_end": {
      const result = toolResultFromEvent(event);
      const duration = typeof result?.metadata?.durationMs === "number" ? ` duration_ms=${result.metadata.durationMs}` : "";
      const warning = sandboxWarning(result?.metadata);
      const tail = typeof result?.content === "string" && result.content.trim()
        ? ` ${truncateMiddle(redactSecretText(result.content.replace(/\s+/g, " ").trim()), 120).text}`
        : "";
      return `[sigma] tool_end ${toolNameFromEvent(event)} ${result?.ok === true ? "ok" : "failed"}${duration}${warning}${tail}`;
    }
    case "context_compaction_start":
      return `[sigma] context_compaction_start strategy=${String(event.metadata?.strategy ?? "?")} compacted_messages=${String(event.metadata?.compacted_message_count ?? "?")}`;
    case "context_compaction_end":
      return `[sigma] context_compaction_end strategy=${String(event.metadata?.strategy ?? "?")} before=${String(event.metadata?.before_message_count ?? "?")} after=${String(event.metadata?.after_message_count ?? "?")} fallback=${String(event.metadata?.fallback_used ?? false)} duration_ms=${String(event.metadata?.duration_ms ?? "?")}`;
    case "context_compaction_error":
      return `[sigma] context_compaction_error strategy=${String(event.metadata?.strategy ?? "?")} fallback=${String(event.metadata?.fallback_used ?? false)} error=${truncateMiddle(redactSecretText(String(event.metadata?.error ?? "unknown")), 160).text}`;
    case "failure_analysis": {
      const analysis = event.metadata?.analysis as { category?: unknown; confidence?: unknown; primaryMessage?: unknown } | undefined;
      const confidence = typeof analysis?.confidence === "number" ? analysis.confidence.toFixed(2) : "?";
      const primary = typeof analysis?.primaryMessage === "string"
        ? ` ${truncateMiddle(redactSecretText(analysis.primaryMessage.replace(/\s+/g, " ").trim()), 120).text}`
        : "";
      return `[sigma] failure_analysis category=${String(analysis?.category ?? "?")} confidence=${confidence}${primary}`;
    }
    case "validation_plan_created": {
      const plan = event.metadata?.validationPlan as { candidates?: unknown[]; skipped?: unknown[] } | undefined;
      return `[sigma] validation_plan_created candidates=${String(plan?.candidates?.length ?? 0)} skipped=${String(plan?.skipped?.length ?? 0)}`;
    }
    case "subagent_start":
      return `[sigma] subagent_start type=${String(event.metadata?.subagent_type ?? "?")} description=${truncateMiddle(redactSecretText(String(event.metadata?.description ?? "").replace(/\s+/g, " ")), 120).text}`;
    case "subagent_end": {
      const report = event.metadata?.report as { status?: unknown; summary?: unknown } | undefined;
      return `[sigma] subagent_end status=${String(report?.status ?? "?")} summary=${truncateMiddle(redactSecretText(String(report?.summary ?? "").replace(/\s+/g, " ")), 160).text}`;
    }
    case "subagent_error": {
      const report = event.metadata?.report as { status?: unknown; summary?: unknown; error?: unknown } | undefined;
      return `[sigma] subagent_error status=${String(report?.status ?? "error")} error=${truncateMiddle(redactSecretText(String(report?.error ?? report?.summary ?? "").replace(/\s+/g, " ")), 160).text}`;
    }
    case "subagent_job_created": {
      const job = event.metadata?.job as { job_id?: unknown; subagent_type?: unknown; description?: unknown } | undefined;
      return `[sigma] subagent_job_created id=${String(job?.job_id ?? "?")} type=${String(job?.subagent_type ?? "?")} description=${truncateMiddle(redactSecretText(String(job?.description ?? "").replace(/\s+/g, " ")), 120).text}`;
    }
    case "subagent_progress":
      return `[sigma] subagent_progress id=${String(event.metadata?.job_id ?? "?")} status=${String(event.metadata?.status ?? "?")}`;
    case "subagent_job_closed": {
      const job = event.metadata?.job as { job_id?: unknown; status?: unknown } | undefined;
      return `[sigma] subagent_job_closed id=${String(job?.job_id ?? "?")} status=${String(job?.status ?? "?")}`;
    }
    case "loop_guard_triggered":
      return `[sigma] loop_guard action=${String(event.metadata?.action ?? "?")} streak=${String(event.metadata?.streak ?? "?")} ${truncateMiddle(redactSecretText(String(event.metadata?.message ?? "").replace(/\s+/g, " ")), 160).text}`;
    case "permission_catalog_updated":
      return `[sigma] permission_catalog_updated rules=${String(event.metadata?.ruleCount ?? "?")} tools=${Array.isArray(event.metadata?.toolsAvailable) ? event.metadata.toolsAvailable.length : "?"}`;
    case "review_gate_start":
      return `[sigma] review_gate_start gate=${String(event.metadata?.gate ?? "?")}`;
    case "review_gate_end":
      return `[sigma] review_gate_end gate=${String(event.metadata?.gate ?? "?")} status=${String(event.metadata?.status ?? "?")} findings=${Array.isArray(event.metadata?.findings) ? event.metadata.findings.length : 0}`;
    case "harness_check_start":
      return `[sigma] ${String(event.metadata?.kind ?? "check")}_start attempt=${String(event.metadata?.attempt ?? "?")} command=${truncateMiddle(redactSecretText(String(event.metadata?.command ?? "")).replace(/\s+/g, " "), 160).text}`;
    case "harness_check_end":
      return `[sigma] ${String(event.metadata?.kind ?? "check")}_end attempt=${String(event.metadata?.attempt ?? "?")} exit=${String(event.metadata?.exitCode ?? "?")} duration_ms=${String(event.metadata?.durationMs ?? "?")}${sandboxWarning(event.metadata)}`;
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
