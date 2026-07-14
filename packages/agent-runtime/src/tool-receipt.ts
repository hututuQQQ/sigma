import type { JsonValue, ModelToolCall, ToolReceipt } from "agent-protocol";

export function failed(
  call: ModelToolCall,
  startedAt: string,
  output: string,
  diagnostic: string,
  result?: JsonValue
): ToolReceipt {
  return {
    callId: call.id, ok: false, output,
    ...(result === undefined ? {} : { result }),
    observedEffects: [], artifacts: [], diagnostics: [diagnostic],
    startedAt, completedAt: new Date().toISOString()
  };
}
