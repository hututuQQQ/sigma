import type { JsonValue, ToolDescriptor } from "agent-protocol";

const TOOL_ARGUMENTS_INVALID = "tool_arguments_invalid" as const;

function invalidArguments(label: string): TypeError & { code: typeof TOOL_ARGUMENTS_INVALID } {
  return Object.assign(new TypeError(
    `${label} arguments must be passed directly as a JSON object matching its schema; `
      + "do not pass a JSON-encoded string."
  ), { code: TOOL_ARGUMENTS_INVALID });
}

export function assertObjectArguments(
  value: JsonValue,
  label: string
): asserts value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArguments(label);
  }
}

/** Enforce the descriptor's top-level container contract before planning or
 * execution. This deliberately does not reinterpret strings as nested JSON:
 * the model-provided value remains the exact value bound to the call. */
export function assertDescriptorArguments(descriptor: ToolDescriptor, value: JsonValue): void {
  if (descriptor.inputSchema.type !== "object") return;
  assertObjectArguments(value, `Tool '${descriptor.name}'`);
}
