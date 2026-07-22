import {
  DEFAULT_ROOT_BUDGET_LIMITS,
  type BudgetAmounts,
  type BudgetLedgerState,
  type BudgetLimits,
  type BudgetMutationV1,
  type CheckpointRef,
  type EvidenceRecord,
  type EvidenceClaim,
  type MutationFrontier,
  type PlanGraph,
  type UsageRecord
} from "./domain-types.js";
import { budgetMutationV1Schema } from "./budget-mutation-schemas.js";
import {
  budgetLedgerStateSchema,
  checkpointRefSchema,
  evidenceRecordSchema,
  mutationFrontierSchema,
  planGraphSchema,
  usageRecordSchema
} from "./domain-schemas.js";

export const SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1 = "sigma.subject_attestation.v1";
const NON_ACTIONABLE_DIAGNOSTIC_SOURCES = new Set([SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1]);

export function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return evidenceRecordSchema.safeParse(value).success;
}

export function isMutationFrontier(value: unknown): value is MutationFrontier {
  return mutationFrontierSchema.safeParse(value).success;
}

export function assertEvidenceRecord(value: unknown): asserts value is EvidenceRecord {
  if (!isEvidenceRecord(value)) throw new Error("Invalid EvidenceRecord.");
}

/**
 * Completion evidence must prove progress on the active user run. Durable
 * provenance records remain auditable, but cannot satisfy task completion.
 */
export function isCompletionEligibleEvidence(
  evidence: EvidenceRecord,
  sessionId: string,
  runId: string
): boolean {
  if (evidence.sessionId !== sessionId || evidence.runId !== runId || evidence.status === "failed") return false;
  if (evidence.kind === "input_access") return false;
  return evidence.kind !== "diagnostic" || !NON_ACTIONABLE_DIAGNOSTIC_SOURCES.has(evidence.data.source);
}

function passedValidationSupportsClaim(evidence: Extract<EvidenceRecord, { kind: "validation" }>): boolean {
  if (evidence.status !== "passed") return false;
  const termination = evidence.data.termination;
  return termination === undefined || (termination.processStarted
    && termination.state === "exited"
    && termination.exitCode === 0
    && !termination.timedOut
    && !termination.idleTimedOut
    && !termination.cancelled);
}

function executedValidationSupportsClaim(evidence: Extract<EvidenceRecord, { kind: "validation" }>): boolean {
  if (evidence.status === "passed") return true;
  return evidence.data.termination?.processStarted === true
    && evidence.data.termination.state === "exited";
}

/** Returns whether an evidence record proves the typed claim attached to a
 * completion reference. An omitted claim is the legacy acceptance_met claim. */
export function evidenceSupportsClaim(
  evidence: EvidenceRecord,
  claim: EvidenceClaim = "acceptance_met"
): boolean {
  if (claim === "acceptance_met") {
    return evidence.status !== "failed"
      && (evidence.kind !== "diagnostic" || !NON_ACTIONABLE_DIAGNOSTIC_SOURCES.has(evidence.data.source));
  }
  if (evidence.kind !== "validation") return false;
  return claim === "validation_passed"
    ? passedValidationSupportsClaim(evidence)
    : executedValidationSupportsClaim(evidence);
}

/** Failed validation is referenceable only for the narrow
 * validation_executed claim. It remains ineligible to prove acceptance. */
export function isCompletionReferenceableEvidence(
  evidence: EvidenceRecord,
  sessionId: string,
  runId: string
): boolean {
  if (evidence.sessionId !== sessionId || evidence.runId !== runId) return false;
  return isCompletionEligibleEvidence(evidence, sessionId, runId)
    || (evidence.kind === "validation" && evidenceSupportsClaim(evidence, "validation_executed"));
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  return usageRecordSchema.safeParse(value).success;
}

export function isPlanGraph(value: unknown): value is PlanGraph {
  return planGraphSchema.safeParse(value).success;
}

export function isBudgetLedgerState(value: unknown): value is BudgetLedgerState {
  return budgetLedgerStateSchema.safeParse(value).success;
}

export function isBudgetMutationV1(value: unknown): value is BudgetMutationV1 {
  return budgetMutationV1Schema.safeParse(value).success;
}

export function isCheckpointRef(value: unknown): value is CheckpointRef {
  return checkpointRefSchema.safeParse(value).success;
}

export function emptyBudgetAmounts(): BudgetAmounts {
  return { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0, toolCalls: 0, children: 0 };
}

export function createBudgetLedger(limits: BudgetLimits = DEFAULT_ROOT_BUDGET_LIMITS): BudgetLedgerState {
  return { limits: { ...limits }, consumed: emptyBudgetAmounts(), reserved: emptyBudgetAmounts(), reservations: [] };
}

export function createEmptyPlan(goal = ""): PlanGraph {
  return { revision: 0, goal, nodes: [] };
}
