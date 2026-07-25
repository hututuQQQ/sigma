import type {
  JsonValue,
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";

export function args(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function stringArg(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  return value;
}

export function descriptor(
  input: Omit<ToolDescriptor, "inputSchema"> & {
    properties: Record<string, JsonValue>;
    required?: string[];
  }
): ToolDescriptor {
  return {
    ...input,
    inputSchema: {
      type: "object",
      properties: input.properties,
      ...(input.required ? { required: input.required } : {}),
      additionalProperties: false
    }
  };
}

export function receipt(
  request: ToolRequest,
  startedAt: string,
  input: Partial<Omit<ToolReceipt, "callId" | "startedAt" | "completedAt">>
): ToolReceipt {
  const ok = input.ok ?? true;
  const output = input.output ?? "";
  const diagnostics = input.diagnostics ?? [];
  return {
    callId: request.callId,
    ok,
    output,
    ...(input.result === undefined ? {} : { result: input.result }),
    outcome: input.outcome ?? {
      status: ok ? "succeeded" : "failed",
      output,
      diagnosticCodes: diagnostics
    },
    observedEffects: input.observedEffects ?? [],
    actualEffects: input.actualEffects ?? input.observedEffects ?? [],
    workspaceDelta: input.workspaceDelta,
    artifacts: input.artifacts ?? [],
    diagnostics,
    evidence: input.evidence ?? [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}
