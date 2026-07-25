import { isTaskControlStateV1 } from "./task-control-state.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Fields written by early published V5 snapshots before TaskControlStateV1.
 * They are accepted only by the V5 snapshot decoder and never copied to V6.
 */
export const LEGACY_V5_TASK_CONTROL_KEYS = [
  "taskControl",
  "completionRepairAttempts",
  "completionRepair",
  "continuationAttempts",
  "repeatedToolBatchCount",
  "receiptCountAtLastUserInput",
  "semanticProgress",
  "semanticFailureCluster",
  "lastToolBatchSignature",
  "lastToolBatchOutcomeSignature"
] as const;

export interface LegacyKernelStateV5Projection {
  completionDraft?: string;
}

/**
 * Read the only V5 semantic value worth preserving: a user-visible answer
 * drafted before the old convergence controller protected it. Phase,
 * obligations, retry debt, and semantic counters intentionally disappear.
 */
export function decodeLegacyKernelStateV5(value: unknown): LegacyKernelStateV5Projection | null {
  const state = record(value);
  if (!state || state.schemaVersion !== 5) return null;
  const control = record(state.taskControl);
  if (control && !isTaskControlStateV1(control)) return null;
  const candidate = record(control?.completionCandidate);
  const currentDraft = typeof candidate?.answer === "string"
    ? candidate.answer.trim()
    : "";
  const repair = record(state.completionRepair);
  const publishedDraft = typeof repair?.answer === "string"
    ? repair.answer.trim()
    : "";
  return {
    ...(currentDraft || publishedDraft
      ? { completionDraft: currentDraft || publishedDraft }
      : {})
  };
}
