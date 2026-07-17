import type { JsonValue, ModelToolCall, ToolCallPlan, ToolReceipt } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export function failedExternalInputReceipt(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan,
  receipt: ToolReceipt,
  failureCode: string
): ToolReceipt {
  if (call.name !== "read" || !plan.exactEffects.includes("filesystem.read.external")) {
    return receipt;
  }
  const input = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, JsonValue> : {};
  const requested = typeof input.path === "string" ? input.path : plan.readPaths[0];
  return {
    ...receipt,
    evidence: requested ? [{
      evidenceId: `input-access:${call.id}`,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "input_access",
      status: "failed",
      createdAt: new Date().toISOString(),
      producer: { authority: "tool", id: call.id },
      summary: `External input '${requested}' could not be read.`,
      data: { path: requested, scope: "external", failureCode }
    }] : []
  };
}
