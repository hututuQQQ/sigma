import { createHash } from "node:crypto";
import type { EvidenceRecord, JsonValue, ModelToolCall, ToolReceipt } from "agent-protocol";
import { toolBatchSignature } from "./model-convergence.js";
import type { KernelState } from "./state.js";

type ToolBatchProgress = Pick<
  KernelState,
  "lastToolBatchSignature" | "lastToolBatchOutcomeSignature" | "repeatedToolBatchCount"
  | "progressEvidenceDigest" | "progressEvidenceFingerprints" | "progressEvidenceRecordCount"
>;

const TERMINAL_PROTOCOL_TOOLS = new Set([
  "runtime_finalize", "confirm_no_change", "report_blocked", "request_user_input"
]);

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

function updateJsonDigest(
  hash: ReturnType<typeof createHash>,
  value: JsonValue
): void {
  if (value === null) hash.update("null;");
  else if (typeof value === "string") {
    hash.update(`string:${Buffer.byteLength(value, "utf8")}:`);
    hash.update(value, "utf8");
  } else if (typeof value === "number" || typeof value === "boolean") {
    hash.update(`${typeof value}:${String(value)};`);
  } else if (Array.isArray(value)) {
    hash.update(`array:${value.length}:[`);
    for (const item of value) updateJsonDigest(hash, item);
    hash.update("]");
  } else {
    const keys = Object.keys(value).sort();
    hash.update(`object:${keys.length}:{`);
    for (const key of keys) {
      updateJsonDigest(hash, key);
      updateJsonDigest(hash, value[key]!);
    }
    hash.update("}");
  }
}

function jsonDigest(value: JsonValue): string {
  const hash = createHash("sha256");
  updateJsonDigest(hash, value);
  return hash.digest("hex");
}

function xorDigest(left: string, right: string): string {
  const output = Buffer.alloc(32);
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  for (let index = 0; index < output.length; index += 1) output[index] = leftBytes[index]! ^ rightBytes[index]!;
  return output.toString("hex");
}

function stringSetSemantics(values: readonly string[]): JsonValue {
  let digest = "0".repeat(64);
  const unique = new Set(values);
  for (const value of unique) {
    digest = xorDigest(digest, createHash("sha256").update(value, "utf8").digest("hex"));
  }
  return { count: unique.size, digest };
}

type EvidenceOf<Kind extends EvidenceRecord["kind"]> = Extract<EvidenceRecord, { kind: Kind }>;

function validationSemantics(evidence: EvidenceOf<"validation">): JsonValue {
  return {
    status: evidence.status,
    validator: evidence.data.validator,
    ...(evidence.data.command === undefined ? {} : { command: evidence.data.command }),
    ...(evidence.data.exitCode === undefined ? {} : { exitCode: evidence.data.exitCode }),
    ...(evidence.data.termination ? { termination: evidence.data.termination } : {}),
    frontierRevision: evidence.data.frontierRevision,
    stateDigest: evidence.data.stateDigest,
    coveredPaths: stringSetSemantics(evidence.data.coveredPaths),
    ...(evidence.data.claim ? { claim: evidence.data.claim } : {})
  };
}

function commandResultSemantics(evidence: EvidenceOf<"command">): JsonValue {
  return {
    status: evidence.status,
    exitCode: evidence.data.exitCode,
    ...(evidence.data.signal === undefined ? {} : { signal: evidence.data.signal }),
    artifactIds: stringSetSemantics(evidence.data.artifactIds ?? []),
    ...(evidence.data.stdoutArtifactId === undefined
      ? {} : { stdoutArtifactId: evidence.data.stdoutArtifactId }),
    ...(evidence.data.stderrArtifactId === undefined
      ? {} : { stderrArtifactId: evidence.data.stderrArtifactId })
  };
}

const VOLATILE_EVIDENCE_KEYS = new Set([
  "callId", "requestId", "eventId", "evidenceId", "usageId", "reservationId",
  "createdAt", "startedAt", "completedAt", "occurredAt", "timestamp",
  "turnId", "effectRevision"
]);

function semanticEvidenceValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(semanticEvidenceValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !VOLATILE_EVIDENCE_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, semanticEvidenceValue(item)]));
}

function semanticArgumentShape(value: JsonValue): JsonValue {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: uniqueSorted(value.map((item) => canonicalJson(semanticArgumentShape(item))))
    };
  }
  if (typeof value !== "object") return typeof value;
  return {
    type: "object",
    fields: Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, semanticArgumentShape(item)]))
  };
}

function semanticToolBatchSignature(calls: readonly ModelToolCall[]): string {
  const actions = calls.map((call) => canonicalJson({
    name: call.name,
    arguments: semanticArgumentShape(call.arguments)
  })).sort();
  return jsonDigest(actions);
}

function planObligationSemantics(state: KernelState): JsonValue {
  return state.plan.nodes
    .filter((node) => node.status !== "completed" && node.status !== "cancelled")
    .map((node) => ({
      id: node.id,
      status: node.status,
      owner: node.owner,
      dependencies: uniqueSorted(node.dependencies),
      acceptanceCriteria: uniqueSorted(node.acceptanceCriteria),
      evidence: node.evidence.map((item) => canonicalJson(item)).sort()
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function receiptWorkspaceDeltaSemantics(receipts: readonly ToolReceipt[]): JsonValue {
  return {
    added: stringSetSemantics(receipts.flatMap((receipt) => receipt.workspaceDelta?.added ?? [])),
    modified: stringSetSemantics(receipts.flatMap((receipt) => receipt.workspaceDelta?.modified ?? [])),
    deleted: stringSetSemantics(receipts.flatMap((receipt) => receipt.workspaceDelta?.deleted ?? []))
  };
}

function terminalReceiptSemantics(receipt: ToolReceipt): JsonValue {
  const outcome = receipt.outcome ?? {
    status: receipt.ok ? "succeeded" as const : "failed" as const,
    output: receipt.output,
    diagnosticCodes: receipt.diagnostics
  };
  return {
    ok: receipt.ok,
    ...(receipt.result === undefined ? {} : { resultDigest: jsonDigest(receipt.result) }),
    outcome: {
      status: outcome.status,
      diagnosticCodes: uniqueSorted(outcome.diagnosticCodes)
    },
    diagnostics: uniqueSorted(receipt.diagnostics)
  };
}

interface EvidenceProgressState {
  progressEvidenceDigest: string;
  progressEvidenceFingerprints: string[];
  progressEvidenceRecordCount: number;
}

/** Snapshot fields are only a serialized projection, never an authority. The
 * first use of an evidence array recomputes every fingerprint; immutable
 * reducer states that share the same array then reuse the verified result in
 * O(1), without trusting a restored or forged digest. */
const verifiedEvidenceProgress = new WeakMap<readonly EvidenceRecord[], EvidenceProgressState>();

function evidenceFingerprint(evidence: EvidenceRecord): string | null {
  if (evidence.kind === "workspace_delta" || evidence.kind === "repository_delta") return null;
  if (evidence.kind === "validation") return jsonDigest(validationSemantics(evidence));
  if (evidence.kind === "command") return jsonDigest(commandResultSemantics(evidence));
  // IDs, timestamps, and producer call IDs are deliberately excluded. A new
  // semantic result changes progress; replaying the same diagnostic or review
  // under a fresh evidence ID does not wash action debt.
  return jsonDigest({
    kind: evidence.kind,
    status: evidence.status,
    summary: evidence.summary,
    data: semanticEvidenceValue(evidence.data as JsonValue)
  } as JsonValue);
}

function rebuildEvidenceProgress(evidence: readonly EvidenceRecord[]): EvidenceProgressState {
  const fingerprints = [...new Set(evidence.flatMap((item) => evidenceFingerprint(item) ?? []))].sort();
  return {
    progressEvidenceDigest: fingerprints.reduce(xorDigest, "0".repeat(64)),
    progressEvidenceFingerprints: fingerprints,
    progressEvidenceRecordCount: evidence.length
  };
}

function evidenceProgressState(state: KernelState): EvidenceProgressState {
  const verified = verifiedEvidenceProgress.get(state.evidence);
  if (verified?.progressEvidenceRecordCount === state.evidence.length) return verified;
  const rebuilt = rebuildEvidenceProgress(state.evidence);
  verifiedEvidenceProgress.set(state.evidence, rebuilt);
  return rebuilt;
}

function progressStateSemantics(state: KernelState, evidenceDigest: string): JsonValue {
  return {
    workspace: {
      baselineManifestDigest: state.mutationFrontier.baselineManifestDigest,
      currentStateDigest: state.mutationFrontier.currentStateDigest,
      ...(state.mutationFrontier.repositoryStateDigest
        ? { repositoryStateDigest: state.mutationFrontier.repositoryStateDigest } : {}),
      changedPaths: stringSetSemantics(state.mutationFrontier.changedPaths)
    },
    validationFrontierDigest: evidenceDigest,
    validationRequirement: state.validationRequirement ?? "required",
    planObligations: planObligationSemantics(state),
    activeProcesses: uniqueSorted(state.activeProcessIds)
  };
}

function completedOutcomeSignature(
  state: KernelState,
  calls: ModelToolCall[],
  receipts: Map<string, ToolReceipt>,
  evidenceDigest: string
): string | null {
  const completedReceipts = calls.flatMap((call): ToolReceipt[] => {
    const receipt = receipts.get(call.id);
    return receipt ? [receipt] : [];
  });
  if (completedReceipts.length !== calls.length) return null;
  const terminalProtocol = calls.some((call) => TERMINAL_PROTOCOL_TOOLS.has(call.name));
  const terminalBatch = terminalProtocol ? calls.map((call) => canonicalJson({
    call: { name: call.name, arguments: call.arguments },
    receipt: terminalReceiptSemantics(receipts.get(call.id)!)
  })).sort() : undefined;
  return createHash("sha256").update(canonicalJson({
    progress: progressStateSemantics(state, evidenceDigest),
    ...(terminalBatch ? { terminalBatch } : { action: semanticToolBatchSignature(calls) }),
    workspaceDelta: receiptWorkspaceDeltaSemantics(completedReceipts)
  })).digest("hex");
}

function resetProgress(evidenceProgress: EvidenceProgressState): ToolBatchProgress {
  return {
    ...evidenceProgress,
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
  const evidenceProgress = evidenceProgressState(state);
  const calls = [...state.messages].reverse().find((message) => message.role === "assistant"
    && message.toolCalls?.some((call) => call.id === completedCallId))?.toolCalls;
  if (!calls?.length) return resetProgress(evidenceProgress);
  const receipts = new Map(state.receipts.map((receipt) => [receipt.callId, receipt]));
  const outcomeSignature = completedOutcomeSignature(state, calls, receipts, evidenceProgress.progressEvidenceDigest);
  if (!outcomeSignature) return resetProgress(evidenceProgress);
  const callSignature = toolBatchSignature(calls);
  const repeatedToolBatchCount = outcomeSignature === state.lastToolBatchOutcomeSignature
    ? state.repeatedToolBatchCount + 1 : 1;
  return {
    ...evidenceProgress,
    lastToolBatchSignature: callSignature,
    lastToolBatchOutcomeSignature: outcomeSignature,
    repeatedToolBatchCount
  };
}

/**
 * Durable evidence, workspace-frontier and process events can arrive after the
 * tool receipt that closed a batch. Rebase the stored post-batch fingerprint
 * when those events materially change trusted state. This keeps a productive
 * action from consuming the no-progress streak while semantic duplicates do
 * not evade convergence by minting new IDs or timestamps.
 */
export function refreshCompletedToolBatchProgress(
  state: KernelState,
  rebaseCurrentBatch = false
): ToolBatchProgress {
  const evidenceProgress = evidenceProgressState(state);
  if (!state.lastToolBatchSignature || !state.lastToolBatchOutcomeSignature) return {
    ...evidenceProgress,
    lastToolBatchSignature: state.lastToolBatchSignature,
    lastToolBatchOutcomeSignature: state.lastToolBatchOutcomeSignature,
    repeatedToolBatchCount: state.repeatedToolBatchCount
  };
  const calls = [...state.messages].reverse().find((message) => message.role === "assistant"
    && message.toolCalls?.length)?.toolCalls;
  if (!calls?.length || toolBatchSignature(calls) !== state.lastToolBatchSignature) {
    return resetProgress(evidenceProgress);
  }
  const receipts = new Map(state.receipts.map((receipt) => [receipt.callId, receipt]));
  const outcomeSignature = completedOutcomeSignature(state, calls, receipts, evidenceProgress.progressEvidenceDigest);
  if (!outcomeSignature) return resetProgress(evidenceProgress);
  if (outcomeSignature !== state.lastToolBatchOutcomeSignature && rebaseCurrentBatch) {
    // Evidence emitted immediately after the receipt belongs to the batch we
    // just completed. Rebase that batch onto the new trusted frontier instead
    // of forgetting it altogether. The productive batch remains the baseline
    // (count 1), so the next semantically identical batch can be recognized as
    // the second no-progress attempt.
    return {
      ...evidenceProgress,
      lastToolBatchSignature: state.lastToolBatchSignature,
      lastToolBatchOutcomeSignature: outcomeSignature,
      repeatedToolBatchCount: 1
    };
  }
  if (outcomeSignature !== state.lastToolBatchOutcomeSignature) return resetProgress(evidenceProgress);
  return {
    ...evidenceProgress,
    lastToolBatchSignature: state.lastToolBatchSignature,
    lastToolBatchOutcomeSignature: outcomeSignature,
    repeatedToolBatchCount: state.repeatedToolBatchCount
  };
}
