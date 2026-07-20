import { createHash } from "node:crypto";
import type { EvidenceRecord, JsonValue, ModelToolCall } from "agent-protocol";
import { toolBatchSignature } from "./model-convergence.js";
import type { KernelState } from "./state.js";

type ToolBatchProgress = Pick<
  KernelState,
  "lastToolBatchSignature" | "lastToolBatchOutcomeSignature" | "repeatedToolBatchCount"
  | "progressEvidenceDigest" | "progressEvidenceFingerprints" | "progressEvidenceRecordCount"
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

function validationSemantics(evidence: EvidenceOf<"validation">): Record<string, JsonValue> {
  return {
    status: evidence.status,
    validator: evidence.data.validator,
    ...(evidence.data.exitCode === undefined ? {} : { exitCode: evidence.data.exitCode }),
    ...(evidence.data.termination ? { termination: evidence.data.termination } : {}),
    frontierRevision: evidence.data.frontierRevision,
    stateDigest: evidence.data.stateDigest,
    coveredPaths: stringSetSemantics(evidence.data.coveredPaths),
    ...(evidence.data.claim ? { claim: evidence.data.claim } : {})
  };
}

function satisfiedPlanObligationSemantics(state: KernelState): JsonValue {
  return state.plan.nodes
    .filter((node) => node.status === "completed")
    .map((node) => ({
      id: node.id,
      owner: node.owner,
      evidence: node.evidence.map((item) => canonicalJson({
        kind: item.kind,
        ...(item.claim ? { claim: item.claim } : {})
      })).sort()
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
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

function validationFingerprint(evidence: EvidenceOf<"validation">): string | null {
  return evidence.status === "passed"
    && (!evidence.data.claim || evidence.data.claim.status === "passed") ? jsonDigest({
    kind: evidence.kind,
    ...validationSemantics(evidence)
  }) : null;
}

function inputAccessFingerprints(evidence: EvidenceOf<"input_access">): string[] {
  if (evidence.status !== "passed") return [];
  const input = {
    kind: evidence.kind,
    scope: evidence.data.scope,
    path: evidence.data.path
  };
  // Progress is a new canonical path or a new actual returned-content binding
  // for that path. The full-file digest and range metadata are retained for
  // audit but deliberately do not participate: only the selection digest is
  // bound by the runtime sanitizer to the exact receipt output, so changing a
  // reported whole-file hash, selection kind, offset, or limit cannot wash
  // action debt without discovering new returned bytes.
  return [
    jsonDigest({ ...input, dimension: "path" }),
    ...(evidence.data.selection ? [jsonDigest({
      ...input,
      dimension: "selection",
      sha256: evidence.data.selection.sha256
    })] : [])
  ];
}

function reviewFingerprint(evidence: EvidenceOf<"review">): string | null {
  return evidence.status === "passed"
    && evidence.data.verdict === "approved" ? jsonDigest({
    kind: evidence.kind,
    status: evidence.status,
    verdict: evidence.data.verdict,
    frontierRevision: evidence.data.frontierRevision,
    stateDigest: evidence.data.stateDigest,
    ...(evidence.data.reviewBasisDigest ? { reviewBasisDigest: evidence.data.reviewBasisDigest } : {})
  }) : null;
}

function waiverFingerprint(evidence: EvidenceOf<"user_waiver">): string {
  return jsonDigest({
    kind: evidence.kind,
    status: evidence.status,
    scope: evidence.data.scope,
    ...(evidence.data.checkpointId ? { checkpointId: evidence.data.checkpointId } : {})
  });
}

function evidenceFingerprints(evidence: EvidenceRecord): string[] {
  // Workspace and repository progress are represented by the authoritative
  // mutation frontier below. Raw command output and diagnostics are explicitly
  // not progress: changing a command string, artifact ID, log text, or probe
  // wording must not wash action debt.
  switch (evidence.kind) {
    case "validation": {
      const fingerprint = validationFingerprint(evidence);
      return fingerprint ? [fingerprint] : [];
    }
    case "input_access": return inputAccessFingerprints(evidence);
    case "review": {
      const fingerprint = reviewFingerprint(evidence);
      return fingerprint ? [fingerprint] : [];
    }
    case "user_waiver": return [waiverFingerprint(evidence)];
    default: return [];
  }
}

function rebuildEvidenceProgress(evidence: readonly EvidenceRecord[]): EvidenceProgressState {
  const fingerprints = [...new Set(evidence.flatMap(evidenceFingerprints))].sort();
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
    semanticEvidenceDigest: evidenceDigest,
    validationRequirement: state.validationRequirement ?? "required",
    satisfiedPlanObligations: satisfiedPlanObligationSemantics(state),
    activeProcesses: uniqueSorted(state.activeProcessIds)
  };
}

function currentProgressSignature(state: KernelState, evidenceDigest: string): string {
  return createHash("sha256").update(canonicalJson({
    progress: progressStateSemantics(state, evidenceDigest)
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

function preserveProgress(
  state: KernelState,
  evidenceProgress: EvidenceProgressState
): ToolBatchProgress {
  return {
    ...evidenceProgress,
    lastToolBatchSignature: state.lastToolBatchSignature,
    lastToolBatchOutcomeSignature: state.lastToolBatchOutcomeSignature,
    repeatedToolBatchCount: state.repeatedToolBatchCount
  };
}

export function repeatsCompletedToolBatch(state: KernelState, calls: ModelToolCall[]): boolean {
  return semanticActionDebt(state) >= 2
    && typeof state.lastToolBatchOutcomeSignature === "string"
    && toolBatchSignature(calls) === state.lastToolBatchSignature;
}

/** Effective action debt is derived from the current trusted state instead of
 * blindly trusting the serialized counter. This makes plan/frontier progress
 * visible immediately even when its durable event is not a tool sidecar. */
export function semanticActionDebt(state: KernelState): number {
  if (!state.lastToolBatchOutcomeSignature) return Math.max(0, state.repeatedToolBatchCount);
  const evidenceProgress = evidenceProgressState(state);
  return currentProgressSignature(state, evidenceProgress.progressEvidenceDigest)
    === state.lastToolBatchOutcomeSignature ? Math.max(0, state.repeatedToolBatchCount) : 0;
}

export function completedToolBatchProgress(state: KernelState, completedCallId: string): ToolBatchProgress {
  const evidenceProgress = evidenceProgressState(state);
  const calls = [...state.messages].reverse().find((message) => message.role === "assistant"
    && message.toolCalls?.some((call) => call.id === completedCallId))?.toolCalls;
  if (!calls?.length) return resetProgress(evidenceProgress);
  const receipts = new Map(state.receipts.map((receipt) => [receipt.callId, receipt]));
  if (!calls.every((call) => receipts.has(call.id))) return resetProgress(evidenceProgress);
  const outcomeSignature = currentProgressSignature(state, evidenceProgress.progressEvidenceDigest);
  const callSignature = toolBatchSignature(calls);
  const repeatedToolBatchCount = state.lastToolBatchOutcomeSignature === undefined
    ? 1
    : outcomeSignature === state.lastToolBatchOutcomeSignature
      ? state.repeatedToolBatchCount + 1
      : 1;
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
  if (!state.lastToolBatchSignature || !state.lastToolBatchOutcomeSignature) {
    return preserveProgress(state, evidenceProgress);
  }
  const calls = [...state.messages].reverse().find((message) => message.role === "assistant"
    && message.toolCalls?.length)?.toolCalls;
  // The stored fingerprint belongs to the last fully completed batch. A newer
  // model call, checkpoint.created, or another in-flight protocol event cannot
  // replace that baseline before the focused action has a durable receipt.
  if (!calls?.length || toolBatchSignature(calls) !== state.lastToolBatchSignature) {
    return preserveProgress(state, evidenceProgress);
  }
  const receipts = new Map(state.receipts.map((receipt) => [receipt.callId, receipt]));
  if (!calls.every((call) => receipts.has(call.id))) return preserveProgress(state, evidenceProgress);
  const outcomeSignature = currentProgressSignature(state, evidenceProgress.progressEvidenceDigest);
  if (outcomeSignature !== state.lastToolBatchOutcomeSignature && rebaseCurrentBatch) {
    // Evidence emitted immediately after the receipt belongs to the batch we
    // just completed. It is trusted progress, so action debt is cleared while
    // the new state becomes the comparison baseline for subsequent actions.
    return {
      ...evidenceProgress,
      lastToolBatchSignature: state.lastToolBatchSignature,
      lastToolBatchOutcomeSignature: outcomeSignature,
      repeatedToolBatchCount: 0
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
