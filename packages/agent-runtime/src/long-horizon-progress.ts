import type {
  LongHorizonActionOutcome,
  ModelMessage,
  ToolReceipt
} from "agent-protocol";

export interface ProgressBatch {
  assistant: ModelMessage;
  calls: NonNullable<ModelMessage["toolCalls"]>;
  receipts: ToolReceipt[];
}

export type MarginalProgressSignal =
  | "workspace_revision"
  | "plan_revision"
  | "validation_evidence"
  | "artifact"
  | "discriminating_result";

export interface MarginalProgressHistory {
  resultDigests: Set<string>;
  validationEvidenceIds: Set<string>;
  artifactIds: Set<string>;
}

export function emptyMarginalProgressHistory(): MarginalProgressHistory {
  return {
    resultDigests: new Set(),
    validationEvidenceIds: new Set(),
    artifactIds: new Set()
  };
}

function nonemptyWorkspaceDelta(receipt: ToolReceipt): boolean {
  const delta = receipt.workspaceDelta;
  return Boolean(delta
    && delta.added.length + delta.modified.length + delta.deleted.length > 0);
}

function receiptEvidence(receipt: ToolReceipt): readonly NonNullable<ToolReceipt["evidence"]>[number][] {
  return receipt.evidence ?? [];
}

function workspaceRevision(receipt: ToolReceipt): boolean {
  return nonemptyWorkspaceDelta(receipt) || receiptEvidence(receipt).some((evidence) =>
    evidence.kind === "workspace_delta"
      || evidence.kind === "repository_delta"
      || (evidence.kind === "diagnostic"
        && evidence.data.source === "enclosing_container_mutation"));
}

function hasNewValidationEvidence(
  receipt: ToolReceipt,
  history: MarginalProgressHistory
): boolean {
  return receiptEvidence(receipt).some((evidence) =>
    evidence.kind === "validation"
      && !history.validationEvidenceIds.has(evidence.evidenceId));
}

function receiptArtifactIds(receipt: ToolReceipt): string[] {
  return [...receipt.artifacts, ...(receipt.artifactRefs ?? []).map((item) => item.artifactId)];
}

function hasNewArtifact(receipt: ToolReceipt, history: MarginalProgressHistory): boolean {
  return receiptArtifactIds(receipt).some((id) => !history.artifactIds.has(id));
}

/**
 * A task-neutral progress vector. It deliberately uses only durable runtime
 * facts: workspace revisions, plan revisions, validation evidence, artifacts,
 * and a result shape not observed in the bounded comparison history. Reworded
 * model text, new call IDs, timestamps, and elapsed time cannot manufacture progress.
 */
export function marginalProgressSignals(
  batch: ProgressBatch,
  outcome: LongHorizonActionOutcome,
  history: MarginalProgressHistory
): MarginalProgressSignal[] {
  const signals = new Set<MarginalProgressSignal>();
  if (batch.receipts.some(workspaceRevision)) signals.add("workspace_revision");
  if (batch.calls.some((call, index) =>
    call.name === "update_plan" && batch.receipts[index]?.ok)) {
    signals.add("plan_revision");
  }
  if (batch.receipts.some((receipt) => hasNewValidationEvidence(receipt, history))) {
    signals.add("validation_evidence");
  }
  if (batch.receipts.some((receipt) => hasNewArtifact(receipt, history))) {
    signals.add("artifact");
  }
  if (!history.resultDigests.has(outcome.resultDigest)) {
    signals.add("discriminating_result");
  }
  return [...signals];
}

export function batchMadeMarginalProgress(
  batch: ProgressBatch,
  outcome: LongHorizonActionOutcome,
  history: MarginalProgressHistory
): boolean {
  return marginalProgressSignals(batch, outcome, history).length > 0;
}

export function recordMarginalProgress(
  history: MarginalProgressHistory,
  batch: ProgressBatch,
  outcome: LongHorizonActionOutcome
): void {
  history.resultDigests.add(outcome.resultDigest);
  for (const receipt of batch.receipts) {
    for (const evidence of receiptEvidence(receipt)) {
      if (evidence.kind === "validation") {
        history.validationEvidenceIds.add(evidence.evidenceId);
      }
    }
    for (const id of receiptArtifactIds(receipt)) history.artifactIds.add(id);
  }
}
