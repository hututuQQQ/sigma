import { redactSecretText, type AgentEvent, type TokenTotals } from "agent-core";

export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toolArgsObject(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? redactSecretText(args[key] as string) : undefined;
}

function summarizeGeneric(args: Record<string, unknown> | null): string {
  if (!args) return "";
  return truncate(redactSecretText(JSON.stringify(args)), 120);
}

export function summarizeToolArguments(toolName: string, argsValue: unknown): string {
  const args = toolArgsObject(argsValue);
  if (!args) return "";
  if (toolName === "bash") {
    const command = stringArg(args, "command");
    return command ? `command=${truncate(oneLine(command), 160)}` : summarizeGeneric(args);
  }
  if (toolName === "shell_session") {
    const action = stringArg(args, "action") ?? "action";
    const input = stringArg(args, "input");
    const session = stringArg(args, "sessionId");
    return truncate(oneLine([`action=${action}`, session ? `session=${session}` : "", input ? `input=${input}` : ""].filter(Boolean).join(" ")), 160);
  }
  if (toolName === "service") {
    const action = stringArg(args, "action") ?? "action";
    const name = stringArg(args, "name");
    const command = stringArg(args, "command");
    return truncate(oneLine([`action=${action}`, name ? `name=${name}` : "", command ? `command=${command}` : ""].filter(Boolean).join(" ")), 160);
  }
  if (toolName === "write" || toolName === "edit" || toolName === "read" || toolName === "git_diff") {
    const filePath = stringArg(args, "path");
    return filePath ? `path=${truncate(oneLine(filePath), 140)}` : summarizeGeneric(args);
  }
  if (toolName === "list") {
    const filePath = stringArg(args, "path") ?? ".";
    return `path=${truncate(oneLine(filePath), 140)}`;
  }
  if (toolName === "glob") {
    const pattern = stringArg(args, "pattern");
    const cwd = stringArg(args, "cwd");
    return truncate(oneLine([pattern ? `pattern=${pattern}` : "", cwd ? `cwd=${cwd}` : ""].filter(Boolean).join(" ")), 140);
  }
  if (toolName === "grep") {
    const pattern = stringArg(args, "pattern");
    const filePath = stringArg(args, "path") ?? stringArg(args, "glob");
    return truncate(oneLine([pattern ? `pattern=${pattern}` : "", filePath ? `target=${filePath}` : ""].filter(Boolean).join(" ")), 140);
  }
  if (toolName === "repo_query") {
    const query = stringArg(args, "query");
    return query ? `query=${truncate(oneLine(query), 140)}` : summarizeGeneric(args);
  }
  if (toolName === "apply_patch") {
    const expected = Array.isArray(args.expectedFiles)
      ? args.expectedFiles.filter((item): item is string => typeof item === "string").join(", ")
      : "";
    return expected ? `files=${truncate(oneLine(expected), 140)}` : "patch";
  }
  return summarizeGeneric(args);
}

export function toolNameFromEvent(event: AgentEvent): string {
  if (typeof event.threadItem?.tool_name === "string") return event.threadItem.tool_name;
  const direct = event.metadata?.toolName;
  if (typeof direct === "string") return direct;
  const toolCall = event.metadata?.toolCall as { function?: { name?: unknown } } | undefined;
  return typeof toolCall?.function?.name === "string" ? toolCall.function.name : "unknown";
}

export function toolArgsFromEvent(event: AgentEvent): unknown {
  if (event.threadItem?.input !== undefined) return event.threadItem.input;
  const toolCall = event.metadata?.toolCall as { function?: { arguments?: unknown } } | undefined;
  return toolCall?.function?.arguments;
}

export function toolResultFromEvent(event: AgentEvent): { ok?: boolean; content?: string; metadata?: Record<string, unknown> } | undefined {
  const result = event.threadItem?.result ?? event.metadata?.result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const modelMetadata = record.modelMetadata && typeof record.modelMetadata === "object"
    ? record.modelMetadata as Record<string, unknown>
    : undefined;
  const legacyMetadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata as Record<string, unknown>
    : undefined;
  return {
    ok: typeof record.ok === "boolean" ? record.ok : undefined,
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

export function formatUsage(usage: Partial<TokenTotals> | undefined): string {
  if (!usage) return "input=0 output=0 total=0";
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  return `input=${input} output=${output} total=${total}`;
}

export function eventUsage(event: AgentEvent): Partial<TokenTotals> | undefined {
  const usage = event.metadata?.usage as Partial<TokenTotals> | undefined;
  return usage && typeof usage === "object" ? usage : undefined;
}
