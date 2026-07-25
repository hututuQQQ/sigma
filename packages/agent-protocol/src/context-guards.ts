import type {
  AssuranceResourcePolicy,
  AssuranceReserveState,
  LongHorizonActionOutcome,
  LongHorizonState,
  ReasoningTrajectoryState,
  StrategyReset,
  ToolResultPruneState
} from "./context.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedNonemptyStrings(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every((item) => typeof item === "string" && item.length > 0);
}

const STRATEGY_DECISIONS = new Set([
  "continue_exploring",
  "implement_candidate",
  "revise_plan",
  "validate_current",
  "request_user_input"
]);

const STRATEGY_TRIGGERS = new Set([
  "model_request",
  "input_request",
  "duplicate_result",
  "evidence_window",
  "resource_band"
]);

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasStrategyText(strategy: Record<string, unknown>): boolean {
  return isNonemptyString(strategy.hypothesis)
    && isNonemptyString(strategy.nextDiscriminatingAction)
    && isNonemptyString(strategy.expectedSignal)
    && (strategy.validationTarget === undefined || isNonemptyString(strategy.validationTarget))
    && isNonemptyString(strategy.decisionRationale);
}

function hasStrategyClassification(strategy: Record<string, unknown>): boolean {
  return typeof strategy.decision === "string"
    && STRATEGY_DECISIONS.has(strategy.decision)
    && typeof strategy.trigger === "string"
    && STRATEGY_TRIGGERS.has(strategy.trigger);
}

export function isStrategyReset(value: unknown): value is StrategyReset {
  const strategy = record(value);
  return Boolean(strategy
    && strategy.schemaVersion === 1
    && isDigest(strategy.basisDigest)
    && isBoundedNonemptyStrings(strategy.establishedFacts, 12)
    && isBoundedNonemptyStrings(strategy.falsifiedApproaches, 8)
    && hasStrategyText(strategy)
    && hasStrategyClassification(strategy));
}

function isPercentage(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value)
    && Number(value) >= minimum
    && Number(value) <= maximum;
}

export function isAssuranceResourcePolicy(
  value: unknown
): value is AssuranceResourcePolicy {
  const policy = record(value);
  return Boolean(policy
    && isPercentage(policy.budgetPercent)
    && isBoundedInteger(policy.reviewRounds, 1, 8)
    && isBoundedInteger(policy.repairRounds, 0, 4)
    && isBoundedInteger(policy.reviewerMaxTurns, 1, 32)
    && isBoundedInteger(policy.reviewerMaxToolCalls, 0, 128)
    && isBoundedInteger(policy.repairMaxTurns, 1, 32)
    && isBoundedInteger(policy.repairMaxToolCalls, 0, 128)
    && ["off", "on_demand", "adaptive"].includes(String(policy.strategistMode))
    && isBoundedInteger(policy.duplicateThreshold, 2, 16)
    && isPercentage(policy.strategyRemainingPercent));
}

export function isAssuranceReserveState(value: unknown): value is AssuranceReserveState {
  const reserve = record(value);
  if (!reserve || reserve.schemaVersion !== 1) return false;
  const strategistCapacity = reserve.strategistMode === "off" ? 0 : 1;
  return isAssuranceResourcePolicy(reserve)
    && isNonNegativeInteger(reserve.maxAuxiliaryCalls)
    && Number(reserve.maxAuxiliaryCalls)
      === Number(reserve.reviewRounds) * Number(reserve.reviewerMaxTurns)
        + strategistCapacity
    && Number(reserve.maxAuxiliaryBudgetBps) === Number(reserve.budgetPercent) * 100
    && [
      reserve.strategistCalls,
      reserve.reviewerCalls,
      reserve.repairEpisodes,
      reserve.auxiliaryInputTokens,
      reserve.auxiliaryOutputTokens,
      reserve.auxiliaryCostMicroUsd,
      reserve.protectedRepairTurnsRemaining,
      reserve.protectedToolCallsRemaining
    ].every(isNonNegativeInteger)
    && Number(reserve.strategistCalls) <= strategistCapacity
    && Number(reserve.reviewerCalls) <= Number(reserve.reviewRounds)
    && Number(reserve.repairEpisodes) <= Number(reserve.repairRounds)
    && Number(reserve.protectedRepairTurnsRemaining)
      <= Number(reserve.repairRounds) * Number(reserve.repairMaxTurns)
    && Number(reserve.protectedToolCallsRemaining)
      <= Number(reserve.repairRounds) * Number(reserve.repairMaxToolCalls);
}

function isLongHorizonActionOutcome(value: unknown): value is LongHorizonActionOutcome {
  const outcome = record(value);
  return Boolean(outcome
    && isNonNegativeInteger(outcome.batch)
    && Array.isArray(outcome.toolNames)
    && outcome.toolNames.length > 0
    && outcome.toolNames.every((item) =>
      typeof item === "string" && item.length > 0)
    && isDigest(outcome.callDigest)
    && isDigest(outcome.resultDigest)
    && typeof outcome.summary === "string");
}

export function isLongHorizonState(value: unknown): value is LongHorizonState {
  const state = record(value);
  return Boolean(state
    && state.schemaVersion === 1
    && isNonNegativeInteger(state.goalEpoch)
    && isNonNegativeInteger(state.settledBatchCount)
    && Array.isArray(state.recentOutcomes)
    && state.recentOutcomes.length <= 8
    && state.recentOutcomes.every(isLongHorizonActionOutcome)
    && isNonNegativeInteger(state.duplicateStreak)
    && Number(state.duplicateStreak) <= Number(state.settledBatchCount)
    && typeof state.strategyRequested === "boolean"
    && typeof state.resourceBandTriggered === "boolean"
    && (state.strategy === undefined || isStrategyReset(state.strategy))
    && isAssuranceReserveState(state.assurance));
}

export function isToolResultPruneState(value: unknown): value is ToolResultPruneState {
  const state = record(value);
  return Boolean(state
    && state.schemaVersion === 1
    && Number.isSafeInteger(state.coveredBlocks)
    && Number(state.coveredBlocks) >= 0
    && isDigest(state.sourceDigest)
    && (state.archiveSourceDigest === undefined
      || isDigest(state.archiveSourceDigest)));
}

export function isReasoningTrajectoryState(
  value: unknown
): value is ReasoningTrajectoryState {
  const state = record(value);
  return Boolean(state
    && state.schemaVersion === 1
    && Array.isArray(state.blockDigests)
    && state.blockDigests.length <= 1_024
    && state.blockDigests.every(isDigest)
    && new Set(state.blockDigests as string[]).size === state.blockDigests.length
    && isDigest(state.sourceDigest));
}
