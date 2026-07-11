import { isEvidenceRecord, type JsonValue, type ToolEffect, type ToolReceipt } from "agent-protocol";

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function toolReceipt(value: unknown): ToolReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, JsonValue>;
  if (typeof item.callId !== "string" || typeof item.ok !== "boolean") return null;
  return {
    callId: item.callId,
    ok: item.ok,
    output: text(item.output),
    observedEffects: Array.isArray(item.observedEffects)
      ? item.observedEffects.filter((effect): effect is ToolEffect => typeof effect === "string")
      : [],
    artifacts: Array.isArray(item.artifacts) ? item.artifacts.filter((entry): entry is string => typeof entry === "string") : [],
    diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics.filter((entry): entry is string => typeof entry === "string") : [],
    evidence: Array.isArray(item.evidence) ? item.evidence.filter(isEvidenceRecord) : [],
    startedAt: text(item.startedAt),
    completedAt: text(item.completedAt)
  };
}

export function receiptContent(receipt: ToolReceipt): string {
  return `${receipt.ok ? "Successful" : "Failed"} tool receipt ID: ${receipt.callId}\n${receipt.output}`;
}
