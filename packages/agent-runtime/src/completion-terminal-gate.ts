import type {
  ModelToolCall,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import { failed } from "./tool-receipt.js";
import type { RuntimeSession } from "./types.js";

function unresolvedRepositoryTransactions(session: RuntimeSession): string[] {
  const open = new Set<string>();
  for (const receipt of session.durable.state.receipts) {
    const result = receipt.result && typeof receipt.result === "object"
      && !Array.isArray(receipt.result)
      ? receipt.result as Record<string, unknown>
      : null;
    const handle = typeof result?.transactionHandle === "string"
      ? result.transactionHandle
      : "";
    if (!handle) continue;
    if (result?.status === "conflicts_pending") open.add(handle);
    else if (["completed", "aborted", "restored"].includes(String(result?.status))) {
      open.delete(handle);
    }
  }
  return [...open];
}

function commonTerminalFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  if (session.durable.state.activeProcessIds.length > 0) {
    return failed(
      call,
      startedAt,
      `Terminal outcome is blocked while background processes remain active: ${session.durable.state.activeProcessIds.join(", ")}.`,
      "active_processes"
    );
  }
  if (session.durable.state.checkpointHead?.status === "open"
    || session.recovery.openCheckpointRecovery) {
    return failed(
      call,
      startedAt,
      "Terminal outcome is blocked until the open mutation checkpoint is restored or kept.",
      "checkpoint_recovery_required"
    );
  }
  if (unresolvedRepositoryTransactions(session).length > 0) {
    return failed(
      call,
      startedAt,
      "Terminal outcome is blocked until the open repository transaction is continued or aborted.",
      "repository_transaction_open"
    );
  }
  return null;
}

/**
 * Explicit terminal tools are checked only against hard lifecycle invariants.
 * Validation, review, recovery, and plan semantics remain model-owned.
 */
export function completionFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string
): ToolReceipt | null {
  const terminal = descriptor.possibleEffects.includes("outcome.propose")
    || descriptor.possibleEffects.includes("outcome.report_blocked");
  if (!terminal) return null;
  if (descriptor.possibleEffects.includes("outcome.propose")) {
    return failed(
      call,
      startedAt,
      "Natural model stop is the completion protocol; no completion tool is registered.",
      "internal_tool_denied"
    );
  }
  return commonTerminalFailure(session, call, startedAt);
}
