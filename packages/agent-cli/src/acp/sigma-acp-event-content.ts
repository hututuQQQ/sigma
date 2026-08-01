import * as acp from "@agentclientprotocol/sdk";

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function nonempty(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function toolKind(name: string, effects: readonly string[] = []): acp.ToolKind {
  if (effects.some((effect) => effect === "filesystem.write" || effect === "repository.write")) {
    return "edit";
  }
  if (effects.some((effect) => effect.startsWith("process."))) return "execute";
  if (effects.includes("network")) return "fetch";
  if (/search|find|grep/iu.test(name)) return "search";
  if (/read|list|inspect|status/iu.test(name)) return "read";
  return "other";
}

export function textContent(text: string): acp.ToolCallContent[] {
  return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

export function payloadText(value: unknown, keys: readonly string[]): string {
  const data = object(value);
  for (const key of keys) {
    const text = nonempty(data?.[key]);
    if (text) return text;
  }
  return "";
}
