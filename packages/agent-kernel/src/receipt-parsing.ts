import {
  isEvidenceRecord,
  type JsonValue,
  type ToolEffect,
  type ToolOutcome,
  type ToolReceipt,
  type WorkspaceDelta
} from "agent-protocol";

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function toolEffects(value: JsonValue | undefined): ToolEffect[] {
  return Array.isArray(value) ? value.filter((effect): effect is ToolEffect => typeof effect === "string") : [];
}

function toolOutcome(value: JsonValue | undefined): ToolOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if ((value.status !== "succeeded" && value.status !== "failed") || typeof value.output !== "string"
    || !Array.isArray(value.diagnosticCodes)) return undefined;
  return {
    status: value.status,
    output: value.output,
    diagnosticCodes: value.diagnosticCodes.filter((entry): entry is string => typeof entry === "string")
  };
}

function workspaceDelta(value: JsonValue | undefined): WorkspaceDelta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (![value.added, value.modified, value.deleted].every((items) =>
    Array.isArray(items) && items.every((item) => typeof item === "string"))) return undefined;
  return {
    added: [...value.added as string[]],
    modified: [...value.modified as string[]],
    deleted: [...value.deleted as string[]]
  };
}

export function toolReceipt(value: unknown): ToolReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, JsonValue>;
  if (typeof item.callId !== "string" || typeof item.ok !== "boolean") return null;
  const outcome = toolOutcome(item.outcome);
  const actualEffects = Array.isArray(item.actualEffects) ? toolEffects(item.actualEffects) : undefined;
  const delta = workspaceDelta(item.workspaceDelta);
  return {
    callId: item.callId,
    ok: item.ok,
    output: text(item.output),
    ...(outcome ? { outcome } : {}),
    observedEffects: toolEffects(item.observedEffects),
    ...(actualEffects ? { actualEffects } : {}),
    ...(delta ? { workspaceDelta: delta } : {}),
    artifacts: stringArray(item.artifacts),
    diagnostics: stringArray(item.diagnostics),
    evidence: Array.isArray(item.evidence) ? item.evidence.filter(isEvidenceRecord) : [],
    startedAt: text(item.startedAt),
    completedAt: text(item.completedAt)
  };
}

export function receiptContent(receipt: ToolReceipt): string {
  const heading = `${receipt.ok ? "Successful" : "Failed"} tool receipt ID: ${receipt.callId}`;
  // Preserve the V2 projection for old durable events. Runtime-normalized V3
  // receipts always carry outcome and receive a bounded machine-readable summary.
  if (!receipt.outcome) return `${heading}\n${receipt.output}`;
  const summary = {
    outcome: {
      status: receipt.outcome.status,
      diagnosticCodes: [...new Set(receipt.outcome.diagnosticCodes)].slice(0, 32)
    },
    diagnostics: [...new Set(receipt.diagnostics)].slice(0, 32),
    evidence: (receipt.evidence ?? []).slice(0, 20).map((item) => ({
      evidenceId: item.evidenceId,
      kind: item.kind,
      status: item.status,
      summary: item.summary.slice(0, 240)
    })),
    ...(receipt.workspaceDelta ? { workspaceDelta: receipt.workspaceDelta } : {})
  };
  return `${heading}\nReceipt summary (JSON): ${JSON.stringify(summary)}\nOutput:\n${receipt.output}`;
}
