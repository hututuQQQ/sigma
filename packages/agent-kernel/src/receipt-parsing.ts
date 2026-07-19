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

const MAX_RECEIPT_TEXT_BYTES = 12_000;
const MAX_RECEIPT_SUMMARY_BYTES = 32 * 1024;
const MAX_PROJECTION_ENTRIES = 64;
const MAX_PROJECTION_BYTES = 16 * 1024;
const MAX_PROJECTION_ENTRY_BYTES = 512;

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

function utf8Prefix(value: string, maximumBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function utf8Suffix(value: string, maximumBytes: number): string {
  const reversed = [...value].reverse().join("");
  return [...utf8Prefix(reversed, maximumBytes)].reverse().join("");
}

function boundedText(value: string, maximum = MAX_RECEIPT_TEXT_BYTES): string {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= maximum) return value;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const marker = `\n...[receipt output omitted; bytes=${byteLength}; sha256=${digest}]...\n`;
  const available = Math.max(0, maximum - Buffer.byteLength(marker, "utf8"));
  const head = Math.floor(available / 2);
  const tail = available - head;
  return `${utf8Prefix(value, head)}${marker}${tail > 0 ? utf8Suffix(value, tail) : ""}`;
}

function updateCompleteDigest(hash: ReturnType<typeof createHash>, value: JsonValue): void {
  if (value === null) {
    hash.update("null;");
  } else if (typeof value === "string") {
    hash.update(`string:${Buffer.byteLength(value, "utf8")}:`);
    hash.update(value, "utf8");
  } else if (typeof value === "number" || typeof value === "boolean") {
    hash.update(`${typeof value}:${String(value)};`);
  } else if (Array.isArray(value)) {
    hash.update(`array:${value.length}:[`);
    for (const item of value) updateCompleteDigest(hash, item);
    hash.update("]");
  } else {
    const keys = Object.keys(value).sort();
    hash.update(`object:${keys.length}:{`);
    for (const key of keys) {
      updateCompleteDigest(hash, key);
      updateCompleteDigest(hash, value[key]!);
    }
    hash.update("}");
  }
}

function completeDigest(value: JsonValue): string {
  const hash = createHash("sha256");
  updateCompleteDigest(hash, value);
  return hash.digest("hex");
}

function projectionEntry(value: JsonValue): string {
  if (typeof value === "string") return boundedText(value, MAX_PROJECTION_ENTRY_BYTES);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  const kind = Array.isArray(value) ? `array(${value.length})` : `object(${Object.keys(value).length})`;
  const scalarPreview = Array.isArray(value) ? [] : Object.keys(value).sort().flatMap((key) => {
    const item = value[key];
    return item === null || ["string", "number", "boolean"].includes(typeof item)
      ? [`${key}=${boundedText(String(item), 96)}`] : [];
  }).slice(0, 6);
  return boundedText(
    `${kind}${scalarPreview.length > 0 ? `; ${scalarPreview.join("; ")}` : ""}; sha256=${completeDigest(value)}`,
    MAX_PROJECTION_ENTRY_BYTES
  );
}

function projectedArray(
  values: readonly JsonValue[],
  evidenceRef: string,
  maximumBytes = MAX_PROJECTION_BYTES
): JsonValue {
  const digest = completeDigest(values as JsonValue);
  const entries: string[] = [];
  for (let index = 0; index < Math.min(values.length, MAX_PROJECTION_ENTRIES); index += 1) {
    const value = values[index]!;
    const candidate = [...entries, projectionEntry(value)];
    const projected = {
      version: "bounded_projection_v1",
      entries: candidate,
      totalCount: values.length,
      omittedCount: values.length - candidate.length,
      digest,
      evidenceRef
    };
    if (Buffer.byteLength(JSON.stringify(projected), "utf8") > maximumBytes) break;
    entries.push(candidate.at(-1)!);
  }
  return {
    version: "bounded_projection_v1",
    entries,
    totalCount: values.length,
    omittedCount: values.length - entries.length,
    digest,
    evidenceRef
  };
}

function resultProjection(value: JsonValue, evidenceRef: string): JsonValue {
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? boundedText(value, 8 * 1024) : value;
  }
  if (Array.isArray(value)) return projectedArray(value, evidenceRef, 8 * 1024);
  const candidates: JsonValue[] = [];
  let totalCount = 0;
  for (const key of Object.keys(value).sort()) {
    const item = value[key]!;
    if (Array.isArray(item)) {
      totalCount += item.length;
      for (let index = 0; index < item.length && candidates.length < MAX_PROJECTION_ENTRIES; index += 1) {
        candidates.push(`${key}[${index}]=${projectionEntry(item[index]!)}`);
      }
    } else {
      totalCount += 1;
      if (candidates.length < MAX_PROJECTION_ENTRIES) candidates.push(`${key}=${projectionEntry(item)}`);
    }
  }
  const projected = projectedArray(candidates, evidenceRef, 8 * 1024) as Record<string, JsonValue>;
  projected.totalCount = totalCount;
  projected.omittedCount = Math.max(0, totalCount - (projected.entries as JsonValue[]).length);
  projected.digest = completeDigest(value);
  return projected;
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

function visibleArtifacts(receipt: ToolReceipt): string[] {
  return (receipt.artifactRefs ?? []).slice(0, 32).map((artifact) => boundedText([
    `artifactId=${artifact.artifactId}`,
    `name=${artifact.name}`,
    `digest=${artifact.digest}`,
    ...(artifact.mediaType ? [`mediaType=${artifact.mediaType}`] : []),
    ...(artifact.sizeBytes === undefined ? [] : [`sizeBytes=${artifact.sizeBytes}`])
  ].join("; "), MAX_PROJECTION_ENTRY_BYTES));
}

function receiptEvidenceRef(receipt: ToolReceipt): string {
  return boundedText(
    receipt.evidence?.find((item) => item.kind === "workspace_delta")?.evidenceId
      ?? receipt.evidence?.[0]?.evidenceId ?? `tool-receipt:${receipt.callId}`,
    256
  );
}

function changedPaths(receipt: ToolReceipt): string[] {
  return receipt.workspaceDelta ? [
    ...receipt.workspaceDelta.added.map((item) => `added:${item}`),
    ...receipt.workspaceDelta.modified.map((item) => `modified:${item}`),
    ...receipt.workspaceDelta.deleted.map((item) => `deleted:${item}`)
  ] : [];
}

function receiptSummary(receipt: ToolReceipt, artifacts: string[]): JsonValue {
  const evidenceRef = receiptEvidenceRef(receipt);
  const summary: Record<string, JsonValue> = {
    outcome: {
      status: receipt.outcome!.status,
      diagnosticCodes: projectedArray(
        [...new Set(receipt.outcome!.diagnosticCodes)], evidenceRef, 3 * 1024
      )
    },
    diagnostics: projectedArray([...new Set(receipt.diagnostics)], evidenceRef, 3 * 1024),
    evidence: projectedArray((receipt.evidence ?? []).map((item) => [
      `evidenceId=${item.evidenceId}`, `kind=${item.kind}`, `status=${item.status}`,
      `summary=${boundedText(item.summary, 256)}`
    ].join("; ")), evidenceRef, 3 * 1024)
  };
  if (receipt.result !== undefined) summary.result = resultProjection(receipt.result, evidenceRef);
  if (receipt.workspaceDelta) summary.changedPaths = projectedArray(changedPaths(receipt), evidenceRef, 8 * 1024);
  if (receipt.artifacts.length > 0) {
    summary.artifactIds = projectedArray(receipt.artifacts, evidenceRef, 3 * 1024);
  }
  if (artifacts.length > 0) summary.artifactRefs = projectedArray(artifacts, evidenceRef, 3 * 1024);
  return summary;
}

export function receiptContent(receipt: ToolReceipt): string {
  const heading = `${receipt.ok ? "Successful" : "Failed"} tool receipt ID: ${boundedText(receipt.callId, 256)}`;
  // Preserve the V2 projection for old durable events. Runtime-normalized V3
  // receipts always carry outcome and receive a bounded machine-readable summary.
  const output = boundedText(receipt.output);
  const artifacts = visibleArtifacts(receipt);
  if (!receipt.outcome) {
    const artifactText = artifacts.length > 0
      ? `\nArtifacts: ${JSON.stringify(projectedArray(artifacts, `tool-receipt:${receipt.callId}`, 3 * 1024))}`
      : "";
    return boundedText(`${heading}\n${output}${artifactText}`, MAX_RECEIPT_SUMMARY_BYTES);
  }
  const summary = receiptSummary(receipt, artifacts);
  const serialized = JSON.stringify(summary);
  const safeSummary = Buffer.byteLength(serialized, "utf8") <= MAX_RECEIPT_SUMMARY_BYTES
    ? serialized
    : JSON.stringify(projectedArray(
        [`receipt summary exceeded aggregate budget; sha256=${completeDigest(summary)}`],
        receiptEvidenceRef(receipt),
        4 * 1024
      ));
  return `${heading}\nReceipt summary (JSON): ${safeSummary}\nOutput:\n${output}`;
}
