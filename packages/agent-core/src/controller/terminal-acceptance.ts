export type TerminalTextKind = "empty" | "plain" | "blocker" | "tool_call_text";

export interface TerminalTextAssessment {
  kind: TerminalTextKind;
  reason?: string;
}

const TOOL_CALL_TEXT_PATTERNS = [
  /<[^>\n]*(?:tool_calls?|function_calls?|invoke)\b/i,
  /<\/[^>\n]*(?:tool_calls?|function_calls?|invoke)[^>]*>/i,
  /"tool_calls"\s*:\s*\[/i,
  /"function_call"\s*:/i,
  /"function"\s*:\s*\{[\s\S]{0,400}"name"\s*:/i
];

const BLOCKER_PATTERNS = [
  /\b(blocked|blocker|cannot|can't|unable|impossible|not possible|no safe edit|need(?:s|ed)?|missing|required|requires|permission denied|ambiguous)\b/i,
  /(?:\u963b\u585e|\u5361\u4f4f|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u53ef\u80fd|\u7f3a\u5c11|\u9700\u8981|\u6743\u9650|\u4e0d\u660e\u786e)/
];

export function containsToolCallText(content: string | undefined): boolean {
  if (!content) return false;
  return TOOL_CALL_TEXT_PATTERNS.some((pattern) => pattern.test(content));
}

export function assessTerminalText(content: string | undefined): TerminalTextAssessment {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) return { kind: "empty", reason: "empty_final_text" };
  if (containsToolCallText(trimmed)) return { kind: "tool_call_text", reason: "tool_call_markup_in_text" };
  if (BLOCKER_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { kind: "blocker", reason: "explicit_blocker_text" };
  }
  return { kind: "plain" };
}
