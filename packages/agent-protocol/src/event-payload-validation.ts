import {
  isBudgetLedgerState,
  isCheckpointRef,
  isEvidenceRecord,
  isPlanGraph,
  isUsageRecord,
  type CheckpointRef,
  type EvidenceRecord
} from "./domain.js";
import { isJsonValue } from "./json.js";

type PayloadValidator = (payload: unknown) => boolean;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function evidencePayload(kind?: EvidenceRecord["kind"]): PayloadValidator {
  return (payload) => isEvidenceRecord(payload) && (kind === undefined || payload.kind === kind);
}

function checkpointPayload(status: CheckpointRef["status"]): PayloadValidator {
  return (payload) => isCheckpointRef(payload) && payload.status === status;
}

function planPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && Number.isSafeInteger(item.previousRevision) && isPlanGraph(item.plan));
}

function budgetPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.reservationId) && isBudgetLedgerState(item.ledger));
}

function budgetBoundPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(budgetPayload(payload) && item && text(item.ownerId));
}

function checkpointRecoveryPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.checkpointId) && (item.decision === "restore" || item.decision === "keep"));
}

function processSpawnedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.processId) && text(item.executionId)
    && (item.mode === "pipe" || item.mode === "pty" || item.mode === "background"));
}

function processOutputPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.processId) && (item.stream === "stdout" || item.stream === "stderr")
    && typeof item.chunk === "string");
}

function processExitedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.processId) && (item.exitCode === null || Number.isInteger(item.exitCode))
    && (item.signal === undefined || typeof item.signal === "string"));
}

function processLostPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.processId) && text(item.reason));
}

function checkpointActionPayload(value: unknown): boolean {
  if (value === undefined) return true;
  const action = record(value);
  return Boolean(action && action.kind === "restore" && text(action.checkpointId));
}

function executionPlanPayload(payload: unknown): boolean {
  const item = record(payload);
  const plan = record(item?.plan);
  return Boolean(item && text(item.executionId) && text(item.toolCallId) && plan
    && textArray(plan.exactEffects) && textArray(plan.readPaths) && textArray(plan.writePaths)
    && textArray(plan.checkpointScope) && (plan.network === "none" || plan.network === "full")
    && checkpointActionPayload(plan.checkpointAction)
    && ["none", "pipe", "pty", "background"].includes(String(plan.processMode))
    && ["read_only", "replay_safe", "non_replayable"].includes(String(plan.idempotence)));
}

function executionCompletedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.executionId) && textArray(item.evidenceIds));
}

function executionFailedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.executionId) && text(item.code) && text(item.message));
}

function routeResolvedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.role) && text(item.routeId) && text(item.modelSpecId)
    && nonNegativeInteger(item.attempt) && optionalText(item.tokenizerAssetDigest));
}

function routeFailedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.role) && text(item.routeId) && text(item.modelSpecId)
    && nonNegativeInteger(item.attempt) && text(item.category) && typeof item.semanticDelta === "boolean");
}

function profilePayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.profileId) && text(item.digest) && text(item.artifactId)
    && ["home", "workspace", "builtin"].includes(String(item.source)));
}

function customizationPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.digest) && text(item.artifactId)
    && nonNegativeInteger(item.skillCount) && nonNegativeInteger(item.hookCount)
    && (item.profileCount === undefined || nonNegativeInteger(item.profileCount)));
}

function skillPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.qualifiedName) && text(item.digest) && text(item.artifactId)
    && ["home", "workspace", "builtin"].includes(String(item.source))
    && ((item.executionManifestArtifactId === undefined && item.executionManifestDigest === undefined)
      || (typeof item.executionManifestArtifactId === "string" && /^[a-f0-9]{64}$/u.test(item.executionManifestArtifactId)
        && typeof item.executionManifestDigest === "string" && /^[a-f0-9]{64}$/u.test(item.executionManifestDigest))));
}

function hookStartedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.hookId) && text(item.event) && typeof item.required === "boolean");
}

function hookSettledPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(hookStartedPayload(payload) && item && typeof item.durationMs === "number"
    && Number.isFinite(item.durationMs) && Number(item.durationMs) >= 0 && Object.hasOwn(item, "outcome"));
}

function budgetExhaustedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.dimension) && nonNegativeInteger(item.requested)
    && nonNegativeInteger(item.available));
}

function budgetOverrunPayload(payload: unknown): boolean {
  const item = record(payload);
  if (!item || !text(item.reservationId) || !Array.isArray(item.dimensions) || item.dimensions.length === 0) return false;
  return item.dimensions.every((value) => {
    const dimension = record(value);
    return Boolean(dimension && text(dimension.dimension)
      && ["inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"]
        .includes(String(dimension.dimension))
      && nonNegativeInteger(dimension.reserved)
      && nonNegativeInteger(dimension.actual)
      && nonNegativeInteger(dimension.overReservation)
      && nonNegativeInteger(dimension.limit)
      && nonNegativeInteger(dimension.consumed)
      && nonNegativeInteger(dimension.overLimit));
  });
}

function reviewStartedPayload(payload: unknown): boolean {
  const item = record(payload);
  return Boolean(item && text(item.reviewerId) && textArray(item.workspaceDeltaEvidenceIds)
    && (item.validationEvidenceIds === undefined || textArray(item.validationEvidenceIds)));
}

const VALIDATORS: Partial<Record<string, PayloadValidator>> = {
  "execution.planned": executionPlanPayload,
  "execution.started": (payload) => text(record(payload)?.executionId),
  "execution.completed": executionCompletedPayload,
  "execution.failed": executionFailedPayload,
  "evidence.recorded": evidencePayload(),
  "review.completed": evidencePayload("review"),
  "review.waived": evidencePayload("user_waiver"),
  "usage.recorded": isUsageRecord,
  "checkpoint.created": checkpointPayload("open"),
  "checkpoint.sealed": checkpointPayload("sealed"),
  "checkpoint.restored": checkpointPayload("restored"),
  "checkpoint.recovery_resolved": checkpointRecoveryPayload,
  "plan.updated": planPayload,
  "budget.reserved": budgetPayload,
  "budget.reservation_bound": budgetBoundPayload,
  "budget.committed": budgetPayload,
  "budget.released": budgetPayload,
  "budget.exhausted": budgetExhaustedPayload,
  "budget.overrun": budgetOverrunPayload,
  "budget.limit_increased": (payload) => isBudgetLedgerState(record(payload)?.ledger),
  "process.spawned": processSpawnedPayload,
  "process.output": processOutputPayload,
  "process.exited": processExitedPayload,
  "process.lost": processLostPayload,
  "model.route_resolved": routeResolvedPayload,
  "model.route_failed": routeFailedPayload,
  "profile.resolved": profilePayload,
  "customization.frozen": customizationPayload,
  "skill.loaded": skillPayload,
  "hook.started": hookStartedPayload,
  "hook.completed": hookSettledPayload,
  "hook.failed": hookSettledPayload,
  "review.started": reviewStartedPayload
};

export function validV3Payload(type: string, payload: unknown): boolean {
  return isJsonValue(payload) && (VALIDATORS[type]?.(payload) ?? true);
}
