import type { ToolOutcome, ToolReceipt } from "agent-protocol";
import type { ActiveModelTurn } from "agent-kernel";
import type { RuntimeSession } from "./types.js";

export type DurableToolReceipt = ToolReceipt & { outcome: ToolOutcome };

export function durableToolReceipt(receipt: ToolReceipt): DurableToolReceipt {
  const diagnosticCodes = [...new Set([
    ...(receipt.outcome?.diagnosticCodes ?? []),
    ...receipt.diagnostics
  ])];
  return {
    ...receipt,
    outcome: {
      status: receipt.ok ? "succeeded" : "failed",
      output: receipt.output,
      diagnosticCodes
    }
  };
}

export function receiptToolName(
  session: RuntimeSession,
  receipt: ToolReceipt,
  modelTurn: ActiveModelTurn
): string {
  return session.durable.state.pendingTools.find((item) => item.request.callId === receipt.callId
    && item.modelTurn.turnId === modelTurn.turnId
    && item.modelTurn.effectRevision === modelTurn.effectRevision)?.request.name ?? "tool";
}

export function shouldReviewReceipt(name: string, reviewMode: "off" | "advisory" | "required"): boolean {
  if (name === "request_review") return true;
  if (name === "runtime_finalize") return reviewMode !== "off";
  return reviewMode === "required" && name === "validate";
}

export function runtimeSignal(session: RuntimeSession): AbortSignal {
  return session.execution.controller?.signal ?? new AbortController().signal;
}
