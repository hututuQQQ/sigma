import { isJsonValue } from "./json.js";
import {
  DEFAULT_ROOT_BUDGET_LIMITS,
  type BudgetAmounts,
  type BudgetLedgerState,
  type BudgetLimits,
  type CheckpointDelta,
  type CheckpointRef,
  type EvidenceAuthority,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceStatus,
  type PlanGraph,
  type UsageRecord
} from "./domain-types.js";

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "workspace_delta", "command", "validation", "diagnostic", "review", "checkpoint", "child_outcome", "user_waiver"
];
const EVIDENCE_STATUSES: readonly EvidenceStatus[] = ["passed", "failed", "warning", "informational"];
const EVIDENCE_AUTHORITIES: readonly EvidenceAuthority[] = ["system", "developer", "user", "project", "runtime", "tool"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validCheckpointDelta(value: unknown): value is CheckpointDelta {
  const item = record(value);
  return Boolean(item && stringArray(item.added) && stringArray(item.modified) && stringArray(item.deleted));
}

function validEvidenceBase(
  item: Record<string, unknown>,
  producer: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
  value: unknown
): boolean {
  return [
    Boolean(producer),
    Boolean(data),
    nonEmptyString(item.evidenceId),
    nonEmptyString(item.sessionId),
    nonEmptyString(item.runId),
    EVIDENCE_KINDS.includes(item.kind as EvidenceKind),
    EVIDENCE_STATUSES.includes(item.status as EvidenceStatus),
    validDate(item.createdAt),
    EVIDENCE_AUTHORITIES.includes(producer?.authority as EvidenceAuthority),
    nonEmptyString(item.summary),
    isJsonValue(value)
  ].every(Boolean);
}

type EvidenceDataValidator = (data: Record<string, unknown>) => boolean;

const EVIDENCE_DATA_VALIDATORS: Record<EvidenceKind, EvidenceDataValidator> = {
  workspace_delta: (data) => validCheckpointDelta(data.delta) && nonEmptyString(data.checkpointId),
  command: (data) => [
    nonEmptyString(data.command),
    data.exitCode === null || Number.isInteger(data.exitCode),
    data.artifactIds === undefined || stringArray(data.artifactIds)
  ].every(Boolean),
  validation: (data) => nonEmptyString(data.validator) && stringArray(data.workspaceDeltaEvidenceIds),
  diagnostic: (data) => nonEmptyString(data.source) && isJsonValue(data.diagnostic),
  review: (data) => [
    nonEmptyString(data.reviewerId),
    data.verdict === "approved" || data.verdict === "changes_requested",
    Array.isArray(data.findings),
    stringArray(data.workspaceDeltaEvidenceIds)
  ].every(Boolean),
  checkpoint: (data) => [
    nonEmptyString(data.checkpointId),
    ["open", "sealed", "restored"].includes(String(data.checkpointStatus)),
    nonEmptyString(data.preManifestDigest)
  ].every(Boolean),
  child_outcome: (data) => [
    nonEmptyString(data.childId),
    ["completed", "failed", "cancelled", "blocked"].includes(String(data.outcome)),
    stringArray(data.planNodeIds)
  ].every(Boolean),
  user_waiver: (data) => [
    data.scope === "review" || data.scope === "validation",
    nonEmptyString(data.reason)
  ].every(Boolean)
};

export function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  const item = record(value);
  if (!item) return false;
  const producer = record(item?.producer);
  const data = record(item?.data);
  if (!validEvidenceBase(item, producer, data, value) || !data) return false;
  return EVIDENCE_DATA_VALIDATORS[item.kind as EvidenceKind](data);
}

export function assertEvidenceRecord(value: unknown): asserts value is EvidenceRecord {
  if (!isEvidenceRecord(value)) throw new Error("Invalid EvidenceRecord.");
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  const item = record(value);
  if (!item || !isJsonValue(value)) return false;
  const identifiers = [item.usageId, item.requestId, item.sessionId, item.runId, item.routeId,
    item.providerId, item.modelId, item.tokenizerId];
  const amounts = [item.inputTokens, item.outputTokens, item.reasoningTokens, item.cacheReadTokens,
    item.cacheWriteTokens, item.costMicroUsd, item.latencyMs];
  return identifiers.every(nonEmptyString)
    && ["orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"].includes(String(item.role))
    && (item.tokenizerAccuracy === "exact" || item.tokenizerAccuracy === "approximate")
    && (item.tokenizerAssetDigest === undefined
      || (typeof item.tokenizerAssetDigest === "string" && /^[a-f0-9]{64}$/u.test(item.tokenizerAssetDigest)))
    && typeof item.providerReported === "boolean"
    && amounts.every(nonNegativeInteger)
    && Number.isInteger(item.attempt) && Number(item.attempt) >= 1
    && validDate(item.occurredAt);
}

function validEvidenceRef(value: unknown): boolean {
  const ref = record(value);
  return Boolean(ref && nonEmptyString(ref.evidenceId) && EVIDENCE_KINDS.includes(ref.kind as EvidenceKind));
}

function validPlanOwner(value: unknown): boolean {
  const owner = record(value);
  if (!owner) return false;
  return owner.kind === "root" || (owner.kind === "child" && nonEmptyString(owner.childId));
}

function validPlanNode(node: Record<string, unknown>): boolean {
  const status = String(node.status);
  const statusDetailValid = status !== "blocked" || nonEmptyString(node.blockedReason);
  const completionValid = status !== "completed" || (Array.isArray(node.evidence) && node.evidence.length > 0);
  return [
    nonEmptyString(node.id),
    nonEmptyString(node.title),
    stringArray(node.dependencies),
    ["pending", "in_progress", "blocked", "completed", "cancelled"].includes(status),
    validPlanOwner(node.owner),
    stringArray(node.acceptanceCriteria),
    Array.isArray(node.evidence) && node.evidence.every(validEvidenceRef),
    statusDetailValid,
    completionValid
  ].every(Boolean);
}

function hasDependencyCycle(dependencies: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

export function isPlanGraph(value: unknown): value is PlanGraph {
  const item = record(value);
  if (!item || !Array.isArray(item.nodes)) return false;
  const headerValid = [
    nonNegativeInteger(item.revision),
    typeof item.goal === "string",
    item.nodes.length <= 128,
    item.activeNodeId === undefined || typeof item.activeNodeId === "string"
  ].every(Boolean);
  const nodes = item.nodes.map(record);
  if (!headerValid || nodes.some((node) => !node)) return false;
  const typedNodes = nodes as Array<Record<string, unknown>>;
  if (!typedNodes.every(validPlanNode)) return false;
  const identifiers = new Set(typedNodes.map((node) => node.id as string));
  if (identifiers.size !== typedNodes.length) return false;
  if (item.activeNodeId !== undefined && !identifiers.has(item.activeNodeId as string)) return false;
  const dependencies = new Map(typedNodes.map((node) => [node.id as string, node.dependencies as string[]]));
  const referencesExist = [...dependencies.values()].every((items) => items.every((id) => identifiers.has(id)));
  return referencesExist && !hasDependencyCycle(dependencies);
}

function isBudgetAmounts(value: unknown): value is BudgetAmounts {
  const item = record(value);
  return Boolean(item && [item.inputTokens, item.outputTokens, item.costMicroUsd, item.modelTurns,
    item.toolCalls, item.children].every(nonNegativeInteger));
}

export function isBudgetLedgerState(value: unknown): value is BudgetLedgerState {
  const item = record(value);
  const limits = record(item?.limits);
  if (!item || !limits || !isBudgetAmounts(limits) || !nonNegativeInteger(limits.maxDepth)
    || !isBudgetAmounts(item.consumed) || !isBudgetAmounts(item.reserved) || !Array.isArray(item.reservations)) return false;
  return item.reservations.every((value) => {
    const reservation = record(value);
    return Boolean(reservation && nonEmptyString(reservation.reservationId) && nonEmptyString(reservation.ownerId)
      && ["reserved", "committed", "released"].includes(String(reservation.status))
      && isBudgetAmounts(reservation.requested) && isBudgetAmounts(reservation.consumed)
      && validDate(reservation.createdAt)
      && (reservation.settledAt === undefined || validDate(reservation.settledAt)));
  });
}

export function isCheckpointRef(value: unknown): value is CheckpointRef {
  const item = record(value);
  return Boolean(item && [
    nonEmptyString(item.checkpointId),
    nonEmptyString(item.sessionId),
    nonEmptyString(item.runId),
    ["open", "sealed", "restored"].includes(String(item.status)),
    validDate(item.createdAt),
    nonEmptyString(item.preManifestDigest),
    item.sealedAt === undefined || validDate(item.sealedAt),
    item.restoredAt === undefined || validDate(item.restoredAt),
    item.postManifestDigest === undefined || nonEmptyString(item.postManifestDigest),
    item.delta === undefined || validCheckpointDelta(item.delta),
    isJsonValue(value)
  ].every(Boolean));
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
