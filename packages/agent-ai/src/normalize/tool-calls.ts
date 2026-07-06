import type { ToolCall } from "../types.js";

interface RawToolCall {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
  name?: unknown;
  arguments?: unknown;
}

let generatedId = 0;

function nextToolCallId(): string {
  generatedId += 1;
  return `call_${generatedId.toString(36)}`;
}

export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function normalizeToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }

  return rawToolCalls
    .map((raw): ToolCall | null => {
      const call = raw as RawToolCall;
      const fn = call.function ?? {};
      const name = typeof fn.name === "string" ? fn.name : typeof call.name === "string" ? call.name : "";
      if (!name) {
        return null;
      }

      const rawArguments = Object.prototype.hasOwnProperty.call(fn, "arguments") ? fn.arguments : call.arguments;
      return {
        id: typeof call.id === "string" && call.id.length > 0 ? call.id : nextToolCallId(),
        type: "function",
        function: {
          name,
          arguments: parseToolArguments(rawArguments)
        }
      };
    })
    .filter((call): call is ToolCall => call !== null);
}
