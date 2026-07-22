import type { ModelToolCall, ToolReceipt } from "agent-protocol";
import { failed } from "./effect-helpers.js";
import { failureCode } from "./tool-transaction-support.js";
import type { RuntimeSession } from "./types.js";

export function convergedToolFailure(
  _session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string,
  error: unknown,
  signal: AbortSignal
): ToolReceipt {
  if ((error as { code?: unknown })?.code === "approval_needs_input") throw error;
  const code = failureCode(error, signal);
  // Retry/convergence authority belongs exclusively to TaskControlStateV1.
  // This adapter only turns the concrete operation failure into a durable
  // receipt; it must not maintain a second, argument-sensitive retry ledger.
  return failed(call, startedAt, error instanceof Error ? error.message : String(error), code);
}
