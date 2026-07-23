import type { JsonValue } from "agent-protocol";
import type { TaskControlStateV1 } from "./task-control-state.js";
import { isTaskControlStateV1 } from "./task-control-state.js";
import {
  completionEvidenceObligation,
  createTaskControlState,
  hasPublishedTaskControlLegacyFields,
  protectCompletionCandidate
} from "./task-control.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function legacyCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

const PUBLISHED_V5_REQUIRED_KEYS = [
  "completionRepairAttempts", "continuationAttempts", "repeatedToolBatchCount",
  "receiptCountAtLastUserInput", "semanticProgress"
] as const;

const PUBLISHED_V5_REPAIR_KINDS = new Set([
  "evidence_acquisition", "terminal_action", "protected_completion",
  "completion_prerequisite", "protected_recovery"
]);

function validPublishedLegacyShape(stored: Record<string, unknown>): boolean {
  return PUBLISHED_V5_REQUIRED_KEYS.every((key) => key in stored);
}

function validLegacyRepair(
  stored: Record<string, unknown>,
  repair: Record<string, unknown> | null,
  repairAttempts: number
): boolean {
  if (stored.completionRepair !== undefined && !repair) return false;
  if (repairAttempts > 0 && !repair) return false;
  return !repair || typeof repair.kind === "string" && PUBLISHED_V5_REPAIR_KINDS.has(repair.kind);
}

function migrateLegacyRepair(
  control: TaskControlStateV1,
  repair: Record<string, unknown> | null,
  revision: number
): TaskControlStateV1 {
  const answer = typeof repair?.answer === "string" ? repair.answer.trim() : "";
  const protectedControl = answer ? protectCompletionCandidate(control, answer) : control;
  if (repair?.kind === "evidence_acquisition") {
    return completionEvidenceObligation(protectedControl, revision, "acquire", 0);
  }
  if (repair?.kind === "terminal_action" || repair?.kind === "protected_completion") {
    return completionEvidenceObligation(protectedControl, revision, "terminal", 0);
  }
  if (repair?.kind !== "completion_prerequisite") return protectedControl;
  return completionEvidenceObligation(
    protectedControl,
    revision,
    "acquire",
    legacyCount(repair.evidenceCount),
    {
      ...(typeof repair.originalCallId === "string" ? { originalCallId: repair.originalCallId } : {}),
      ...(repair.arguments === undefined ? {} : { arguments: repair.arguments as JsonValue })
    }
  );
}

function phaseForLegacyDebt(
  current: TaskControlStateV1["phase"],
  noProgressBatches: number
): TaskControlStateV1["phase"] {
  if (noProgressBatches >= 7) return "terminal";
  if (noProgressBatches >= 6) return "repair_only";
  if (noProgressBatches >= 2) return "focused";
  return current;
}

/** Migrate only fields written by published V5 main. Experimental #55 state
 * carries separate versioned markers and is deliberately rejected by restore. */
export function migratePublishedTaskControlState(
  value: unknown,
  revision: number
): TaskControlStateV1 | null {
  const stored = record(value);
  if (!stored) return null;
  if (isTaskControlStateV1(stored.taskControl)) {
    return hasPublishedTaskControlLegacyFields(stored) ? null : stored.taskControl;
  }
  if (!validPublishedLegacyShape(stored)) return null;
  const repair = stored.completionRepair === undefined ? null : record(stored.completionRepair);
  const repairAttempts = legacyCount(stored.completionRepairAttempts);
  if (!validLegacyRepair(stored, repair, repairAttempts)) return null;
  const control = migrateLegacyRepair(createTaskControlState(revision), repair, revision);
  const cluster = record(stored.semanticFailureCluster);
  const noProgressBatches = Math.max(
    legacyCount(stored.repeatedToolBatchCount),
    legacyCount(cluster?.attempts)
  );
  const phase = phaseForLegacyDebt(control.phase, noProgressBatches);
  const obligation = control.obligation && repairAttempts > 0
    ? { ...control.obligation, attempts: repairAttempts }
    : control.obligation;
  return {
    ...control,
    phase,
    ...(obligation ? { obligation } : {}),
    modelContinuationAttempts: legacyCount(stored.continuationAttempts),
    episode: { ...control.episode, noProgressBatches }
  };
}
