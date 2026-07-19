import { createHash } from "node:crypto";
import type { EvidenceRecord, ValidationEvidence } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

const MAX_OBSERVATIONS = 8;
const MAX_TOTAL_BYTES = 4 * 1_024;
const MAX_ITEM_BYTES = 1_024;
const NON_SEMANTIC_DIAGNOSTIC_SOURCES = new Set([
  "runtime_finalize",
  "request_review",
  "confirm_no_change",
  "report_blocked",
  "request_user_input"
]);

export interface ReviewObservationV1 {
  evidenceId: string;
  kind: "command" | "diagnostic" | "input_access";
  status: EvidenceRecord["status"];
  summary: string;
  createdAt: string;
  outputExcerpt?: string;
  outputSha256?: string;
}

export interface ReviewObservationProjectionV1 {
  items: ReviewObservationV1[];
  totalCount: number;
  omittedCount: number;
  contentSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentBudget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function semanticObservation(item: EvidenceRecord): boolean {
  if (item.kind === "command" || item.kind === "input_access") return true;
  return item.kind === "diagnostic" && !NON_SEMANTIC_DIAGNOSTIC_SOURCES.has(item.data.source);
}

function reviewBasisEvidence(item: EvidenceRecord): boolean {
  if (item.kind === "review") return false;
  // Terminal protocol diagnostics are emitted only after the review-first
  // phase. Including them would make every freshly approved review stale by
  // construction even though they add no task evidence.
  return item.kind !== "diagnostic" || !NON_SEMANTIC_DIAGNOSTIC_SOURCES.has(item.data.source);
}

function observationContent(session: RuntimeSession, item: EvidenceRecord): string | undefined {
  if (item.kind === "command") {
    return [...session.durable.state.receipts].reverse()
      .find((receipt) => receipt.callId === item.producer.id)?.output;
  }
  if (item.kind === "diagnostic") {
    try { return JSON.stringify(item.data.diagnostic); } catch { return String(item.data.diagnostic); }
  }
  if (item.kind === "input_access") {
    return JSON.stringify({
      path: item.data.path,
      scope: item.data.scope,
      failureCode: item.data.failureCode ?? null
    });
  }
  return undefined;
}

function signature(session: RuntimeSession, item: EvidenceRecord): string {
  const content = observationContent(session, item) ?? "";
  let data: string;
  try { data = JSON.stringify({ producer: item.producer, data: item.data }); } catch { data = String(item.data); }
  return JSON.stringify({
    evidenceId: item.evidenceId,
    kind: item.kind,
    status: item.status,
    summary: item.summary,
    createdAt: item.createdAt,
    dataSha256: sha256(data),
    contentSha256: sha256(content)
  });
}

function orderedEvidenceSha256(session: RuntimeSession, evidence: readonly EvidenceRecord[]): string {
  const hash = createHash("sha256").update("sigma.review_evidence_tail.v2\0");
  for (const item of evidence) {
    const itemSignature = signature(session, item);
    hash.update(`${Buffer.byteLength(itemSignature, "utf8")}:`);
    hash.update(itemSignature, "utf8");
  }
  return hash.digest("hex");
}

function projectedObservation(session: RuntimeSession, item: EvidenceRecord): ReviewObservationV1 {
  const content = observationContent(session, item);
  return {
    evidenceId: item.evidenceId,
    kind: item.kind as ReviewObservationV1["kind"],
    status: item.status,
    summary: boundedUtf8(item.summary, 512),
    createdAt: item.createdAt,
    ...(content ? {
      outputExcerpt: boundedUtf8(content, MAX_ITEM_BYTES),
      outputSha256: sha256(content)
    } : {})
  };
}

/** Bounded, durable projection of semantic evidence recorded from the first
 * current-frontier validation onward. This makes a later contradictory diagnostic
 * part of the independent review basis without exposing unbounded tool output. */
export function reviewObservationProjection(
  session: RuntimeSession,
  validations: readonly ValidationEvidence[]
): ReviewObservationProjectionV1 {
  const validationIds = new Set(validations.map((item) => item.evidenceId));
  let firstValidationIndex = -1;
  for (let index = 0; index < session.durable.state.evidence.length; index += 1) {
    if (validationIds.has(session.durable.state.evidence[index]!.evidenceId)) {
      firstValidationIndex = index;
      break;
    }
  }
  if (firstValidationIndex < 0) {
    return {
      items: [], totalCount: 0, omittedCount: 0,
      contentSha256: orderedEvidenceSha256(session, [])
    };
  }
  const evidenceTail = session.durable.state.evidence.slice(firstValidationIndex).filter((item) =>
    item.sessionId === session.identity.sessionId
      && item.runId === session.durable.runId
      && reviewBasisEvidence(item));
  const candidates = evidenceTail.filter((item) => !validationIds.has(item.evidenceId) && semanticObservation(item));
  // Bind the full ordered task-evidence tail, not merely the bounded model
  // projection. A repeated validation or non-projected evidence record still
  // makes an old review stale; terminal orchestration noise was removed above.
  const contentSha256 = orderedEvidenceSha256(session, evidenceTail);
  const selected = candidates.slice(-MAX_OBSERVATIONS);
  const items: ReviewObservationV1[] = [];
  for (const item of selected) {
    const projected = projectedObservation(session, item);
    const projectedItems = [...items, projected];
    const candidateProjection: ReviewObservationProjectionV1 = {
      items: projectedItems,
      totalCount: candidates.length,
      omittedCount: candidates.length - projectedItems.length,
      contentSha256
    };
    if (Buffer.byteLength(JSON.stringify(candidateProjection), "utf8") > MAX_TOTAL_BYTES) continue;
    items.push(projected);
  }
  return {
    items,
    totalCount: candidates.length,
    omittedCount: candidates.length - items.length,
    contentSha256
  };
}
