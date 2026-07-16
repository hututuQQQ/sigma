import { createHash } from "node:crypto";
import {
  isEvidenceRecord,
  isJsonValue,
  type JsonValue,
  type ArtifactRef,
  type ToolEffect,
  type ToolOutcome,
  type ToolReceipt,
  type WorkspaceDelta
} from "agent-protocol";

const MAX_RECEIPT_TEXT_CHARS = 12_000;

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function artifactRefs(value: JsonValue | undefined): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    if (typeof entry.artifactId !== "string" || typeof entry.name !== "string" || typeof entry.digest !== "string") return [];
    return [{
      artifactId: entry.artifactId,
      name: entry.name,
      digest: entry.digest,
      ...(typeof entry.mediaType === "string" ? { mediaType: entry.mediaType } : {}),
      ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {})
    }];
  });
}

function boundedText(value: string, maximum = MAX_RECEIPT_TEXT_CHARS): string {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const marker = `\n...[receipt output omitted; chars=${value.length}; sha256=${digest}]...\n`;
  const available = Math.max(0, maximum - marker.length);
  const head = Math.floor(available / 2);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`;
}

function boundedJson(value: JsonValue): string {
  return boundedText(JSON.stringify(value));
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
    ...(isJsonValue(item.result) ? { result: item.result } : {}),
    ...(outcome ? { outcome } : {}),
    observedEffects: toolEffects(item.observedEffects),
    ...(actualEffects ? { actualEffects } : {}),
    ...(delta ? { workspaceDelta: delta } : {}),
    artifacts: stringArray(item.artifacts),
    ...(artifactRefs(item.artifactRefs).length > 0 ? { artifactRefs: artifactRefs(item.artifactRefs) } : {}),
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
  const output = boundedText(receipt.output);
  const artifacts = (receipt.artifactRefs ?? []).slice(0, 32).map((artifact) => ({
    artifactId: artifact.artifactId,
    name: artifact.name,
    digest: artifact.digest,
    ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes })
  }));
  if (!receipt.outcome) {
    return `${heading}\n${output}${artifacts.length > 0 ? `\nArtifacts (JSON): ${JSON.stringify(artifacts)}` : ""}`;
  }
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
    ...(receipt.result === undefined ? {} : { result: boundedJson(receipt.result) }),
    ...(receipt.workspaceDelta ? { workspaceDelta: receipt.workspaceDelta } : {}),
    ...(receipt.artifacts.length > 0 ? { artifactIds: receipt.artifacts.slice(0, 32) } : {}),
    ...(artifacts.length > 0 ? { artifactRefs: artifacts } : {})
  };
  return `${heading}\nReceipt summary (JSON): ${JSON.stringify(summary)}\nOutput:\n${output}`;
}
