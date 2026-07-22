import type { JsonValue } from "agent-protocol";

export type TaskControlPhase = "normal" | "focused" | "repair_only" | "terminal";

export type TaskObligationV1 =
  | {
      kind: "completion_evidence";
      stage: "acquire" | "terminal";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      evidenceCount: number;
      failureCode?: string;
      originalCallId?: string;
      arguments?: JsonValue;
    }
  | {
      kind: "review_repair";
      stage: "mutate" | "validate" | "re_review";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      scopePaths: string[];
    }
  | {
      kind: "capability_recovery";
      stage: "prepare" | "re_probe";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      opportunityId: string;
    }
  | {
      kind: "repository_recovery";
      stage: "inspect" | "select" | "transact" | "validate";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      transactionId?: string;
    }
  | {
      kind: "restoration";
      stage: "quiesce" | "restore" | "confirm";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
    }
  | {
      kind: "process_settlement";
      stage: "settle";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      processIds: string[];
    }
  | {
      kind: "user_decision";
      stage: "request";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      decisionCode: string;
    }
  | {
      kind: "terminal_resolution";
      stage: "report";
      basisDigest: string;
      openedRevision: number;
      attempts: number;
      failureCode: string;
    };

export type SemanticFactKindV1 =
  | "workspace_frontier"
  | "content"
  | "runtime_environment"
  | "process_lifecycle"
  | "validation"
  | "review"
  | "plan"
  | "repository"
  | "restoration";

export interface SemanticFactV1 {
  kind: SemanticFactKindV1;
  digest: string;
  revision: number;
}

export interface SemanticFactLedgerV1 {
  entries: SemanticFactV1[];
}

export interface ActionEpisodeV1 {
  basisDigest: string;
  startedRevision: number;
  noProgressBatches: number;
  observations: number;
  factCountAtBatchStart?: number;
}

export interface ToolPolicyCorrectionStateV1 {
  basisDigest: string;
  attempts: number;
  failureCode: string;
}

export interface CompletionCandidateV1 {
  answer: string;
  digest: string;
}

export interface TaskControlStateV1 {
  schemaVersion: 1;
  goalEpoch: number;
  goalEpochSource: "initial" | "submit" | "steer" | "follow_up";
  phase: TaskControlPhase;
  obligation?: TaskObligationV1;
  semanticFacts: SemanticFactLedgerV1;
  episode: ActionEpisodeV1;
  policyCorrection?: ToolPolicyCorrectionStateV1;
  completionCandidate?: CompletionCandidateV1;
  modelContinuationAttempts: number;
}

const DIGEST = /^[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonEmptyStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function validObligationHeader(obligation: Record<string, unknown>): boolean {
  return typeof obligation.kind === "string" && typeof obligation.stage === "string"
    && typeof obligation.basisDigest === "string" && DIGEST.test(obligation.basisDigest)
    && nonNegativeInteger(obligation.openedRevision) && nonNegativeInteger(obligation.attempts);
}

type ObligationValidator = (obligation: Record<string, unknown>) => boolean;

const OBLIGATION_VALIDATORS: Record<TaskObligationV1["kind"], ObligationValidator> = {
  completion_evidence: (obligation) => ["acquire", "terminal"].includes(String(obligation.stage))
    && nonNegativeInteger(obligation.evidenceCount)
    && (obligation.failureCode === undefined
      || typeof obligation.failureCode === "string" && obligation.failureCode.length > 0),
  review_repair: (obligation) => ["mutate", "validate", "re_review"].includes(String(obligation.stage))
    && nonEmptyStrings(obligation.scopePaths),
  capability_recovery: (obligation) => ["prepare", "re_probe"].includes(String(obligation.stage))
    && typeof obligation.opportunityId === "string" && obligation.opportunityId.length > 0,
  repository_recovery: (obligation) => ["inspect", "select", "transact", "validate"].includes(String(obligation.stage)),
  restoration: (obligation) => ["quiesce", "restore", "confirm"].includes(String(obligation.stage)),
  process_settlement: (obligation) => obligation.stage === "settle" && nonEmptyStrings(obligation.processIds),
  user_decision: (obligation) => obligation.stage === "request"
    && typeof obligation.decisionCode === "string" && obligation.decisionCode.length > 0,
  terminal_resolution: (obligation) => obligation.stage === "report"
    && typeof obligation.failureCode === "string" && obligation.failureCode.length > 0
};

function validObligation(value: unknown): value is TaskObligationV1 {
  const obligation = record(value);
  if (!obligation || !validObligationHeader(obligation)) return false;
  const validator = OBLIGATION_VALIDATORS[obligation.kind as TaskObligationV1["kind"]];
  return validator?.(obligation) ?? false;
}

function validFact(value: unknown): value is SemanticFactV1 {
  const fact = record(value);
  return Boolean(fact && [
    "workspace_frontier", "content", "runtime_environment", "process_lifecycle",
    "validation", "review", "plan", "repository", "restoration"
  ].includes(String(fact.kind)) && typeof fact.digest === "string" && DIGEST.test(fact.digest)
    && nonNegativeInteger(fact.revision));
}

export function isTaskControlStateV1(value: unknown): value is TaskControlStateV1 {
  const state = record(value);
  if (!validTaskControlHeader(state)) return false;
  const facts = record(state.semanticFacts);
  const episode = record(state.episode);
  const correction = state.policyCorrection === undefined ? null : record(state.policyCorrection);
  const candidate = state.completionCandidate === undefined ? null : record(state.completionCandidate);
  return validOptionalObligation(state.obligation)
    && validFactLedger(facts)
    && validEpisode(episode)
    && validCorrection(correction)
    && validCandidate(candidate)
    && nonNegativeInteger(state.modelContinuationAttempts);
}

function validTaskControlHeader(state: Record<string, unknown> | null): state is Record<string, unknown> {
  return Boolean(state && state.schemaVersion === 1 && nonNegativeInteger(state.goalEpoch)
    && ["initial", "submit", "steer", "follow_up"].includes(String(state.goalEpochSource))
    && ["normal", "focused", "repair_only", "terminal"].includes(String(state.phase)));
}

function validOptionalObligation(value: unknown): boolean {
  return value === undefined || validObligation(value);
}

function validFactLedger(facts: Record<string, unknown> | null): boolean {
  if (!facts || !Array.isArray(facts.entries) || !facts.entries.every(validFact)) return false;
  return new Set(facts.entries.map((item) => item.digest)).size === facts.entries.length;
}

function validEpisode(episode: Record<string, unknown> | null): boolean {
  return Boolean(episode && typeof episode.basisDigest === "string" && DIGEST.test(episode.basisDigest)
    && [episode.startedRevision, episode.noProgressBatches, episode.observations].every(nonNegativeInteger)
    && (episode.factCountAtBatchStart === undefined || nonNegativeInteger(episode.factCountAtBatchStart)));
}

function validCorrection(correction: Record<string, unknown> | null): boolean {
  return correction === null || Boolean(typeof correction.basisDigest === "string" && DIGEST.test(correction.basisDigest)
    && nonNegativeInteger(correction.attempts) && typeof correction.failureCode === "string");
}

function validCandidate(candidate: Record<string, unknown> | null): boolean {
  return candidate === null || Boolean(typeof candidate.answer === "string" && candidate.answer.trim().length > 0
    && typeof candidate.digest === "string" && DIGEST.test(candidate.digest));
}
