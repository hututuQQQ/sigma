import type { JsonValue, ModelToolCall, ToolReceipt } from "agent-protocol";

export function failed(
  call: ModelToolCall,
  startedAt: string,
  output: string,
  diagnostic: string,
  result?: JsonValue
): ToolReceipt {
  const diagnostics = [diagnostic];
  return {
    callId: call.id, ok: false, output,
    ...(result === undefined ? {} : { result }),
    outcome: { status: "failed", output, diagnosticCodes: diagnostics },
    observedEffects: [], actualEffects: [], artifacts: [], diagnostics, evidence: [],
    startedAt, completedAt: new Date().toISOString()
  };
}
