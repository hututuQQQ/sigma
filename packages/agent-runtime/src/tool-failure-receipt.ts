import type { ModelToolCall, ToolReceipt } from "agent-protocol";
import { failed } from "./effect-helpers.js";
import { failureCode } from "./tool-transaction-support.js";

export function ordinaryToolFailureReceipt(
  call: ModelToolCall,
  startedAt: string,
  error: unknown,
  signal: AbortSignal
): ToolReceipt {
  if ((error as { code?: unknown })?.code === "approval_needs_input") throw error;
  const code = failureCode(error, signal);
  // Concrete operation failures are durable observations for the model.
  return failed(call, startedAt, error instanceof Error ? error.message : String(error), code);
}
