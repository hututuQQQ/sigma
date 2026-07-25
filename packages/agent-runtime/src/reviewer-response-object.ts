import type { ModelResponse } from "agent-protocol";

function reviewObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function jsonContentObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return reviewObject(JSON.parse(candidate) as unknown);
  } catch {
    return null;
  }
}

export function reviewerResponseObject(
  response: ModelResponse
): Record<string, unknown> | null {
  const calls = response.message.toolCalls ?? [];
  if (calls.length > 0) {
    if (calls.length !== 1
      || !["submit_verification", "submit_review"].includes(calls[0]!.name)) {
      return null;
    }
    return reviewObject(calls[0]!.arguments);
  }
  return jsonContentObject(response.message.content);
}
