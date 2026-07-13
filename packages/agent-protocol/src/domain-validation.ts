import {
  DEFAULT_ROOT_BUDGET_LIMITS,
  type BudgetAmounts,
  type BudgetLedgerState,
  type BudgetLimits,
  type CheckpointRef,
  type EvidenceRecord,
  type PlanGraph,
  type UsageRecord
} from "./domain-types.js";
import {
  budgetLedgerStateSchema,
  checkpointRefSchema,
  evidenceRecordSchema,
  planGraphSchema,
  usageRecordSchema
} from "./domain-schemas.js";

export function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return evidenceRecordSchema.safeParse(value).success;
}

export function assertEvidenceRecord(value: unknown): asserts value is EvidenceRecord {
  if (!isEvidenceRecord(value)) throw new Error("Invalid EvidenceRecord.");
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
