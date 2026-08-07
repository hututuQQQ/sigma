import { createHash } from "node:crypto";
import type { ActiveModelTurn } from "agent-kernel";
import { receiptContent } from "agent-kernel";
import type { ToolOutcome, ToolReceipt } from "agent-protocol";
import { turnPayload } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeEventEmission } from "./runtime-event-emitter.js";
import type { ToolTransactionRunner } from "./tool-transaction-runner.js";
import type { RuntimeSession } from "./types.js";

type DurableToolReceipt = ToolReceipt & { outcome: ToolOutcome };

function durableToolReceipt(receipt: ToolReceipt): DurableToolReceipt {
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

function traceObservation(receipt: DurableToolReceipt) {
  return {
    schemaVersion: 1 as const,
    rawBytes: Buffer.byteLength(receipt.output, "utf8"),
    modelVisibleBytes: Buffer.byteLength(receiptContent(receipt), "utf8"),
    fullOutputDigest: createHash("sha256").update(receipt.output, "utf8").digest("hex")
  };
}

function receiptToolName(
  session: RuntimeSession,
  receipt: ToolReceipt,
  modelTurn: ActiveModelTurn
): string {
  return session.durable.state.pendingTools.find((item) => item.request.callId === receipt.callId
    && item.modelTurn.turnId === modelTurn.turnId
    && item.modelTurn.effectRevision === modelTurn.effectRevision)?.request.name ?? "tool";
}

export class ToolReceiptRecorder {
  constructor(
    private readonly options: Pick<EffectRunnerOptions, "emit" | "emitBatch" | "hooks">,
    private readonly transactions: Pick<ToolTransactionRunner, "settleBudgetsAfterReceipt">
  ) {}

  async record(
    session: RuntimeSession,
    receipt: ToolReceipt,
    modelTurn: ActiveModelTurn,
    explicitName?: string
  ): Promise<void> {
    const name = explicitName ?? receiptToolName(session, receipt, modelTurn);
    await this.emitDurable(session, receipt, modelTurn, name);
    try {
      await this.dispatchPostTool(session, receipt, name);
    } finally {
      await this.transactions.settleBudgetsAfterReceipt(session);
    }
  }

  private async emitDurable(
    session: RuntimeSession,
    receipt: ToolReceipt,
    modelTurn: ActiveModelTurn,
    name: string
  ): Promise<void> {
    const durable = durableToolReceipt(receipt);
    const emissions: RuntimeEventEmission[] = [{
      type: receipt.ok ? "tool.completed" : "tool.failed",
      authority: "tool",
      payload: {
        ...durable, name, traceObservation: traceObservation(durable), ...turnPayload(modelTurn)
      }
    } as RuntimeEventEmission];
    for (const evidence of receipt.evidence ?? []) {
      emissions.push({
        type: "evidence.recorded",
        authority: evidence.producer.authority === "runtime" ? "runtime" : "tool",
        payload: evidence
      });
    }
    if (this.options.emitBatch) {
      await this.options.emitBatch(session, emissions);
      return;
    }
    for (const emission of emissions) {
      await this.options.emit(
        session,
        emission.type,
        emission.authority,
        emission.payload as never
      );
    }
  }

  private async dispatchPostTool(
    session: RuntimeSession,
    receipt: ToolReceipt,
    name: string
  ): Promise<void> {
    await this.options.hooks.dispatch(session, "post_tool", {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      callId: receipt.callId,
      toolName: name,
      ok: receipt.ok,
      diagnostics: receipt.diagnostics,
      actualEffects: receipt.actualEffects ?? receipt.observedEffects,
      evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId),
      artifactRefs: receipt.artifactRefs ?? []
    }, session.execution.controller?.signal ?? new AbortController().signal);
  }
}
