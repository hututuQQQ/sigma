import { createHash } from "node:crypto";
import type { JsonValue, ModelToolCall, ToolReceipt } from "agent-protocol";
import { toolBatchSignature } from "./model-convergence.js";
import type { KernelState } from "./state.js";

type ToolBatchProgress = Pick<
  KernelState,
  "lastToolBatchSignature" | "lastToolBatchOutcomeSignature" | "repeatedToolBatchCount"
>;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentIdentity(value: JsonValue): JsonValue {
  const serialized = typeof value === "string" ? value : canonicalJson(value);
  return {
    characters: serialized.length,
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex")
  };
}

function receiptSemantics(receipt: ToolReceipt): JsonValue {
  const outcome = receipt.outcome ?? {
    status: receipt.ok ? "succeeded" as const : "failed" as const,
    output: contentIdentity(receipt.output),
    diagnosticCodes: receipt.diagnostics
  };
  const artifactRefs = (receipt.artifactRefs ?? []).map((artifact) => ({
    name: artifact.name,
    digest: artifact.digest,
    ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
    ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes })
  }));
  return {
    ok: receipt.ok,
    output: receipt.output,
    outcome: {
      status: outcome.status,
      output: contentIdentity(outcome.output),
      diagnosticCodes: uniqueSorted(outcome.diagnosticCodes)
    },
    diagnostics: uniqueSorted(receipt.diagnostics),
    observedEffects: uniqueSorted(receipt.observedEffects),
    actualEffects: uniqueSorted(receipt.actualEffects ?? receipt.observedEffects),
    workspaceDelta: {
      added: uniqueSorted(receipt.workspaceDelta?.added ?? []),
      modified: uniqueSorted(receipt.workspaceDelta?.modified ?? []),
      deleted: uniqueSorted(receipt.workspaceDelta?.deleted ?? [])
    },
    artifacts: artifactRefs.length > 0
      ? artifactRefs.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
      : uniqueSorted(receipt.artifacts)
  };
}

function completedOutcomeSignature(calls: ModelToolCall[], receipts: Map<string, ToolReceipt>): string | null {
  const entries = calls.flatMap((call): string[] => {
    const receipt = receipts.get(call.id);
    return receipt ? [canonicalJson({
      call: { name: call.name, arguments: call.arguments },
      receipt: receiptSemantics(receipt)
    })] : [];
  });
  if (entries.length !== calls.length) return null;
  return createHash("sha256").update(canonicalJson(entries.sort())).digest("hex");
}

function resetProgress(): ToolBatchProgress {
  return {
    lastToolBatchSignature: undefined,
    lastToolBatchOutcomeSignature: undefined,
    repeatedToolBatchCount: 0
  };
}

export function repeatsCompletedToolBatch(state: KernelState, calls: ModelToolCall[]): boolean {
  return state.repeatedToolBatchCount >= 2
    && typeof state.lastToolBatchOutcomeSignature === "string"
    && toolBatchSignature(calls) === state.lastToolBatchSignature;
}

export function completedToolBatchProgress(state: KernelState, completedCallId: string): ToolBatchProgress {
  const calls = [...state.messages].reverse().find((message) => message.role === "assistant"
    && message.toolCalls?.some((call) => call.id === completedCallId))?.toolCalls;
  if (!calls?.length) return resetProgress();
  const receipts = new Map(state.receipts.map((receipt) => [receipt.callId, receipt]));
  const outcomeSignature = completedOutcomeSignature(calls, receipts);
  if (!outcomeSignature) return resetProgress();
  const callSignature = toolBatchSignature(calls);
  const repeatedToolBatchCount = callSignature === state.lastToolBatchSignature
    && outcomeSignature === state.lastToolBatchOutcomeSignature
    ? state.repeatedToolBatchCount + 1 : 1;
  return {
    lastToolBatchSignature: callSignature,
    lastToolBatchOutcomeSignature: outcomeSignature,
    repeatedToolBatchCount
  };
}
