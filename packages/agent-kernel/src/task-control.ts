import { createHash } from "node:crypto";
import type { JsonValue } from "agent-protocol";
import type {
  SemanticFactKindV1,
  TaskControlStateV1,
  TaskObligationV1
} from "./task-control-state.js";
import { isTaskControlStateV1 } from "./task-control-state.js";
import { policyExhaustionCode } from "./task-control-resolution.js";

const EMPTY_BASIS = createHash("sha256").update("sigma-task-control-v1").digest("hex");

/** Task-control authorities written by the published V5 state before
 * TaskControlStateV1. They may only be consumed by the explicit snapshot
 * migration path and must never coexist with the new reducer-owned state. */
export const PUBLISHED_TASK_CONTROL_LEGACY_KEYS = [
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

export function hasPublishedTaskControlLegacyFields(value: unknown): boolean {
  const stored = record(value);
  return Boolean(stored && PUBLISHED_TASK_CONTROL_LEGACY_KEYS.some((key) => key in stored));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createTaskControlState(revision = 0, goalEpoch = 0): TaskControlStateV1 {
  return {
    schemaVersion: 1,
    goalEpoch,
    goalEpochSource: "initial",
    phase: "normal",
    semanticFacts: { entries: [] },
    episode: {
      basisDigest: digest({ seed: EMPTY_BASIS, goalEpoch }),
      startedRevision: revision,
      noProgressBatches: 0,
      observations: 0
    },
    modelContinuationAttempts: 0
  };
}

export function beginGoalEpoch(
  control: TaskControlStateV1,
  revision: number,
  source: Exclude<TaskControlStateV1["goalEpochSource"], "initial">
): TaskControlStateV1 {
  return { ...createTaskControlState(revision, control.goalEpoch + 1), goalEpochSource: source };
}

export function protectCompletionCandidate(control: TaskControlStateV1, answer: string): TaskControlStateV1 {
  const normalized = answer.trim();
  return normalized ? {
    ...control,
    completionCandidate: { answer: normalized, digest: digest({ answer: normalized }) }
  } : control;
}

export function taskControlAnswer(control: TaskControlStateV1): string | null {
  return control.completionCandidate?.answer ?? null;
}

export function openTaskObligation(
  control: TaskControlStateV1,
  obligation: TaskObligationV1,
  phase: TaskControlStateV1["phase"] = "repair_only"
): TaskControlStateV1 {
  return {
    ...control,
    phase,
    obligation,
    policyCorrection: undefined,
    episode: {
      basisDigest: obligation.basisDigest,
      startedRevision: obligation.openedRevision,
      noProgressBatches: 0,
      observations: 0
    }
  };
}

export function completionEvidenceObligation(
  control: TaskControlStateV1,
  revision: number,
  stage: "acquire" | "terminal",
  evidenceCount: number,
  options: { failureCode?: string; originalCallId?: string; arguments?: JsonValue } = {}
): TaskControlStateV1 {
  const basisDigest = digest({
    kind: "completion_evidence", goalEpoch: control.goalEpoch, stage,
    candidate: control.completionCandidate?.digest, evidenceCount,
    failureCode: options.failureCode,
    originalCallId: options.originalCallId
  });
  return openTaskObligation(control, {
    kind: "completion_evidence",
    stage,
    basisDigest,
    openedRevision: revision,
    attempts: 0,
    evidenceCount,
    ...options
  });
}

export function terminalResolutionObligation(
  control: TaskControlStateV1,
  revision: number,
  failureCode: string
): TaskControlStateV1 {
  const basisDigest = digest({
    kind: "terminal_resolution", goalEpoch: control.goalEpoch, failureCode,
    candidate: control.completionCandidate?.digest
  });
  return {
    ...control,
    phase: "terminal",
    obligation: {
      kind: "terminal_resolution",
      stage: "report",
      basisDigest,
      openedRevision: revision,
      attempts: 0,
      failureCode
    },
    policyCorrection: undefined
  };
}

export function reviewRepairObligation(
  control: TaskControlStateV1,
  revision: number,
  reviewBasisDigest: string,
  scopePaths: string[]
): TaskControlStateV1 {
  return openTaskObligation(control, {
    kind: "review_repair",
    stage: "mutate",
    basisDigest: reviewBasisDigest,
    openedRevision: revision,
    attempts: 0,
    scopePaths: [...new Set(scopePaths)].sort()
  });
}

export function userDecisionObligation(
  control: TaskControlStateV1,
  revision: number,
  decisionCode: string
): TaskControlStateV1 {
  return openTaskObligation(control, {
    kind: "user_decision",
    stage: "request",
    basisDigest: digest({ kind: "user_decision", goalEpoch: control.goalEpoch, decisionCode }),
    openedRevision: revision,
    attempts: 0,
    decisionCode
  }, "terminal");
}

export function advanceReviewRepair(
  control: TaskControlStateV1,
  stage: "mutate" | "validate" | "re_review",
  revision: number
): TaskControlStateV1 {
  const obligation = control.obligation;
  if (obligation?.kind !== "review_repair") return control;
  const basisDigest = digest({
    priorBasis: obligation.basisDigest,
    stage,
    attempts: obligation.attempts + 1,
    goalEpoch: control.goalEpoch
  });
  return openTaskObligation(control, {
    ...obligation,
    stage,
    basisDigest,
    openedRevision: revision,
    attempts: obligation.attempts + 1
  });
}

export function resolveTaskObligation(control: TaskControlStateV1): TaskControlStateV1 {
  return {
    ...control,
    phase: "normal",
    obligation: undefined,
    policyCorrection: undefined,
    episode: {
      ...control.episode,
      noProgressBatches: 0,
      observations: 0,
      factCountAtBatchStart: undefined
    }
  };
}

export function recordSemanticFact(
  control: TaskControlStateV1,
  kind: SemanticFactKindV1,
  subject: unknown,
  revision: number
): { control: TaskControlStateV1; trustedProgress: boolean } {
  const factDigest = digest({ kind, subject });
  if (control.semanticFacts.entries.some((item) => item.digest === factDigest)) {
    return { control, trustedProgress: false };
  }
  const entries = [...control.semanticFacts.entries, { kind, digest: factDigest, revision }];
  return {
    trustedProgress: true,
    control: {
      ...control,
      phase: control.obligation ? control.phase : "normal",
      semanticFacts: { entries },
      policyCorrection: undefined,
      episode: {
        basisDigest: factDigest,
        startedRevision: revision,
        noProgressBatches: 0,
        observations: control.phase === "focused" ? control.episode.observations + 1 : 0,
        factCountAtBatchStart: control.episode.factCountAtBatchStart
      }
    }
  };
}

export function startActionBatch(control: TaskControlStateV1): TaskControlStateV1 {
  return {
    ...control,
    episode: { ...control.episode, factCountAtBatchStart: control.semanticFacts.entries.length }
  };
}

export function completeActionBatch(control: TaskControlStateV1, revision: number): TaskControlStateV1 {
  const before = control.episode.factCountAtBatchStart;
  if (before === undefined) return control;
  const progressed = control.semanticFacts.entries.length > before;
  if (progressed) {
    return {
      ...control,
      phase: control.obligation ? control.phase : "normal",
      episode: { ...control.episode, noProgressBatches: 0, factCountAtBatchStart: undefined }
    };
  }
  const noProgressBatches = control.episode.noProgressBatches + 1;
  const convergenceTerminal = noProgressBatches >= 7;
  const phase = convergenceTerminal ? "terminal"
    : noProgressBatches >= 6 ? "repair_only"
      : noProgressBatches >= 2 ? "focused" : control.phase;
  const next = {
    ...control,
    phase,
    episode: { ...control.episode, noProgressBatches, factCountAtBatchStart: undefined }
  };
  return convergenceTerminal && control.obligation?.kind !== "terminal_resolution"
    ? terminalResolutionObligation(next, revision, "action_convergence_no_progress") : next;
}

export function recordToolPolicyViolation(
  control: TaskControlStateV1,
  failureCode: string,
  revision: number
): TaskControlStateV1 {
  const obligation = control.obligation;
  const basisDigest = digest({
    goalEpoch: control.goalEpoch,
    episodeBasisDigest: control.episode.basisDigest,
    obligation: obligation ? {
      kind: obligation.kind,
      stage: obligation.stage,
      basisDigest: obligation.basisDigest
    } : null
  });
  const attempts = control.policyCorrection?.basisDigest === basisDigest
    ? control.policyCorrection.attempts + 1 : 1;
  const updated: TaskControlStateV1 = {
    ...control,
    phase: control.obligation || control.phase !== "normal" ? control.phase : "focused",
    policyCorrection: { basisDigest, attempts, failureCode }
  };
  const resolutionCode = policyExhaustionCode(control);
  if (attempts < 2) return updated;
  return {
    ...terminalResolutionObligation(updated, revision, resolutionCode),
    // Preserve the exhausted counter until the terminal outcome is proposed.
    // Callers must not infer exhaustion from phase="terminal" because some
    // obligations (notably user decisions) are terminal from their first turn.
    policyCorrection: updated.policyCorrection
  };
}

export function toolPolicyCorrectionExhausted(control: TaskControlStateV1): boolean {
  return (control.policyCorrection?.attempts ?? 0) >= 2;
}

export function taskControlFailureMessage(control: TaskControlStateV1, detail: string): string {
  const answer = taskControlAnswer(control);
  if (!answer || detail.startsWith(answer)) return detail;
  return `${answer}\n\n[Task control resolution failed: ${detail}]`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
export function migratePublishedTaskControlState(value: unknown, revision: number): TaskControlStateV1 | null {
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
