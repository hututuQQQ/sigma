const CODEX_DEVELOPER_SENTINEL_PREFIX = "\u0000sigma-codex-developer:";
const CODEX_SYSTEM_SENTINEL_PREFIX = "\u0000sigma-codex-system:";

export function codexInstructionSentinel(
  role: "system" | "developer",
  nonce: string,
  content: string
): string {
  const prefix = role === "system"
    ? CODEX_SYSTEM_SENTINEL_PREFIX
    : CODEX_DEVELOPER_SENTINEL_PREFIX;
  return `${prefix}${nonce}\u0000${content}`;
}

function restoredCodexInstruction(
  text: unknown,
  nonce: string
): { role: "system" | "developer"; text: string } | undefined {
  if (typeof text !== "string") return undefined;
  for (const [prefix, role] of [
    [CODEX_SYSTEM_SENTINEL_PREFIX, "system"],
    [CODEX_DEVELOPER_SENTINEL_PREFIX, "developer"]
  ] as const) {
    const marker = `${prefix}${nonce}\u0000`;
    if (text.startsWith(marker)) return { role, text: text.slice(marker.length) };
  }
  return undefined;
}

/**
 * Pi's provider-neutral Context has no mid-conversation developer role. Keep
 * dynamic instructions in their chronological suffix as private user-message
 * sentinels, then restore their real role in the Codex Responses payload.
 */
export function codexPayload(payload: unknown, nonce: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.input)) return payload;
  let changed = false;
  const input = body.input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const message = item as Record<string, unknown>;
    if (message.role !== "user" || !Array.isArray(message.content)
      || message.content.length !== 1) return item;
    const content = message.content[0];
    if (!content || typeof content !== "object" || Array.isArray(content)) return item;
    const textPart = content as Record<string, unknown>;
    if (textPart.type !== "input_text") return item;
    const restored = restoredCodexInstruction(textPart.text, nonce);
    if (!restored) return item;
    changed = true;
    return {
      ...message,
      role: restored.role,
      content: [{ ...textPart, text: restored.text }]
    };
  });
  return changed ? { ...body, input } : payload;
}
