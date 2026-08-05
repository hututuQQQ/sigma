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
  validationSemanticKeys: Set<string>;
  artifactIds: Set<string>;
  /** Novel diagnostic output is useful while exploring, but it cannot reset
   * convergence forever. A durable commitment starts a fresh bounded window. */
  discriminatingResultsSinceCommit: number;
}

const MAX_DISCRIMINATING_RESULT_CREDITS = 2;

export function emptyMarginalProgressHistory(): MarginalProgressHistory {
  return {
    resultDigests: new Set(),
    validationEvidenceIds: new Set(),
    validationSemanticKeys: new Set(),
    artifactIds: new Set(),
    discriminatingResultsSinceCommit: 0
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

type ReceiptEvidence = NonNullable<ToolReceipt["evidence"]>[number];
type ValidationEvidence = Extract<ReceiptEvidence, { kind: "validation" }>;

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort((left, right) => left.localeCompare(right));
}

/** Identity of the assurance fact, excluding per-execution IDs, timestamps,
 * output previews, and artifact IDs. A rerun on the same frontier is progress
 * only when its target or pass/fail state changes. */
function validationSemanticKey(evidence: ValidationEvidence): string {
  const claim = evidence.data.claim ?? evidence.data.adapterInference;
  return JSON.stringify({
    validator: evidence.data.validator,
    frontierRevision: evidence.data.frontierRevision,
    stateDigest: evidence.data.stateDigest,
    coveredPaths: sorted(evidence.data.coveredPaths),
    intent: evidence.data.intent ? {
      purpose: evidence.data.intent.purpose ?? null,
      subjects: sorted(evidence.data.intent.subjects),
      criterionIds: sorted(evidence.data.intent.criterionIds)
    } : null,
    claim: claim ? {
      kind: claim.kind,
      status: claim.status,
      subject: {
        projectId: claim.subject.projectId ?? null,
        configPaths: sorted(claim.subject.configPaths),
        selectedTests: sorted(claim.subject.selectedTests),
        exactFiles: sorted(claim.subject.exactFiles)
      }
    } : null,
    status: evidence.status
  });
}

function hasNewValidationEvidence(
  receipt: ToolReceipt,
  history: MarginalProgressHistory
): boolean {
  return receiptEvidence(receipt).some((evidence) =>
    evidence.kind === "validation"
      && !history.validationEvidenceIds.has(evidence.evidenceId)
      && !history.validationSemanticKeys.has(validationSemanticKey(evidence)));
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
 * and a bounded number of result shapes not observed in the comparison
 * history. Reworded model text, new call IDs, timestamps, elapsed time, and an
 * unbounded stream of novel stdout cannot manufacture progress.
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
  if (!history.resultDigests.has(outcome.resultDigest)
    && history.discriminatingResultsSinceCommit < MAX_DISCRIMINATING_RESULT_CREDITS) {
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
  const strongProgress = batch.receipts.some(workspaceRevision)
    || batch.calls.some((call, index) =>
      call.name === "update_plan" && batch.receipts[index]?.ok)
    || batch.receipts.some((receipt) => hasNewValidationEvidence(receipt, history))
    || batch.receipts.some((receipt) => hasNewArtifact(receipt, history));
  const novelResult = !history.resultDigests.has(outcome.resultDigest);
  if (strongProgress) {
    history.discriminatingResultsSinceCommit = 0;
  } else if (novelResult
    && history.discriminatingResultsSinceCommit < MAX_DISCRIMINATING_RESULT_CREDITS) {
    history.discriminatingResultsSinceCommit += 1;
  }
  history.resultDigests.add(outcome.resultDigest);
  for (const receipt of batch.receipts) {
    for (const evidence of receiptEvidence(receipt)) {
      if (evidence.kind === "validation") {
        history.validationEvidenceIds.add(evidence.evidenceId);
        history.validationSemanticKeys.add(validationSemanticKey(evidence));
      }
    }
    for (const id of receiptArtifactIds(receipt)) history.artifactIds.add(id);
  }
}
