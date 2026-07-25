import type {
  AssuranceResourcePolicyV1,
  AssuranceReserveStateV1,
  AssuranceReserveStateV2,
  ContextArchiveV1,
  ContextItem,
  LongHorizonActionOutcomeV1,
  LongHorizonStateV1,
  LongHorizonStateV2,
  ReasoningTrajectoryStateV1,
  RuntimePromptStateV2,
  StrategyResetActionV1,
  StrategyResetV1,
  StrategyResetV2,
  ToolResultPruneStateV1
} from "./context.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isContextItem(value: unknown): value is ContextItem {
  const item = record(value);
  return Boolean(item
    && typeof item.id === "string" && item.id.length > 0
    && ["system", "developer", "user", "project", "runtime", "tool"].includes(String(item.authority))
    && typeof item.provenance === "string" && item.provenance.length > 0
    && typeof item.content === "string"
    && Number.isSafeInteger(item.tokenCount) && Number(item.tokenCount) >= 0
    && typeof item.priority === "number" && Number.isFinite(item.priority)
    && (item.cacheKey === undefined || typeof item.cacheKey === "string"));
}

export function isContextArchiveV1(value: unknown): value is ContextArchiveV1 {
  const archive = record(value);
  return Boolean(archive
    && archive.schemaVersion === 1
    && isContextItem(archive.item)
    && Number.isSafeInteger(archive.omittedHistoryTurns)
    && Number(archive.omittedHistoryTurns) >= 0
    && isDigest(archive.sourceDigest)
    && archive.item.cacheKey === archive.sourceDigest);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isRuntimePromptStateV2(value: unknown): value is RuntimePromptStateV2 {
  const state = record(value);
  const sections = record(state?.sectionDigests);
  if (!state || state.schemaVersion !== 2 || !sections) return false;
  const allowed = new Set(["repository", "completion", "plan", "budget", "longHorizon"]);
  if (Object.keys(sections).some((key) => !allowed.has(key))) return false;
  return [
    sections.repository,
    sections.completion,
    sections.plan,
    sections.budget,
    sections.longHorizon
  ].every((digest) => digest === undefined || isDigest(digest))
    && [100, 50, 25, 10, 0].includes(Number(state.budgetBand))
    && (state.archiveSourceDigest === undefined
      || isDigest(state.archiveSourceDigest));
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStrategyResetActionV1(value: unknown): value is StrategyResetActionV1 {
  const action = record(value);
  return Boolean(action
    && typeof action.title === "string" && action.title.length > 0
    && typeof action.expectedSignal === "string" && action.expectedSignal.length > 0
    && ["inspect", "change", "validate", "ask"].includes(String(action.kind)));
}

function isBoundedNonemptyStrings(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every((item) => typeof item === "string" && item.length > 0);
}

export function isStrategyResetV1(value: unknown): value is StrategyResetV1 {
  const strategy = record(value);
  return Boolean(strategy
    && strategy.schemaVersion === 1
    && isDigest(strategy.basisDigest)
    && isBoundedNonemptyStrings(strategy.establishedFacts, 12)
    && isBoundedNonemptyStrings(strategy.lowYieldApproaches, 8)
    && typeof strategy.hypothesis === "string" && strategy.hypothesis.length > 0
    && Array.isArray(strategy.nextActions)
    && strategy.nextActions.length >= 1 && strategy.nextActions.length <= 3
    && strategy.nextActions.every(isStrategyResetActionV1)
    && (strategy.validationTarget === undefined
      || (typeof strategy.validationTarget === "string"
        && strategy.validationTarget.length > 0)));
}

function validOptionalStrategyTarget(strategy: Record<string, unknown>): boolean {
  return strategy.validationTarget === undefined
    || (typeof strategy.validationTarget === "string"
      && strategy.validationTarget.length > 0);
}

function validStrategyDecision(strategy: Record<string, unknown>): boolean {
  const decision = strategy.decision;
  const rationale = strategy.decisionRationale;
  if (decision === undefined) return rationale === undefined;
  return [
    "continue_exploring",
    "implement_candidate",
    "revise_plan",
    "validate_current",
    "request_user_input"
  ].includes(String(decision))
    && typeof rationale === "string"
    && rationale.length > 0;
}

function validStrategyResetV2Core(strategy: Record<string, unknown>): boolean {
  return strategy.schemaVersion === 2
    && isDigest(strategy.basisDigest)
    && isBoundedNonemptyStrings(strategy.establishedFacts, 12)
    && isBoundedNonemptyStrings(strategy.falsifiedApproaches, 8)
    && typeof strategy.hypothesis === "string"
    && strategy.hypothesis.length > 0
    && typeof strategy.nextDiscriminatingAction === "string"
    && strategy.nextDiscriminatingAction.length > 0
    && typeof strategy.expectedSignal === "string"
    && strategy.expectedSignal.length > 0;
}

export function isStrategyResetV2(value: unknown): value is StrategyResetV2 {
  const strategy = record(value);
  return Boolean(strategy
    && validStrategyResetV2Core(strategy)
    && [
      "model_request",
      "input_request",
      "duplicate_result",
      "evidence_window",
      "resource_band"
    ]
      .includes(String(strategy.trigger))
    && validStrategyDecision(strategy)
    && validOptionalStrategyTarget(strategy));
}

function isAssuranceReserveStateV1(value: unknown): value is AssuranceReserveStateV1 {
  const reserve = record(value);
  return Boolean(reserve
    && reserve.schemaVersion === 1
    && reserve.maxAuxiliaryCalls === 3
    && reserve.maxAuxiliaryBudgetBps === 2000
    && [
      reserve.strategistCalls,
      reserve.reviewerCalls,
      reserve.auxiliaryInputTokens,
      reserve.auxiliaryOutputTokens,
      reserve.auxiliaryCostMicroUsd,
      reserve.protectedRepairTurnsRemaining,
      reserve.protectedToolCallsRemaining
    ].every(isNonNegativeInteger)
    && Number(reserve.strategistCalls) <= 1
    && Number(reserve.reviewerCalls) <= 2
    && Number(reserve.strategistCalls) + Number(reserve.reviewerCalls) <= 3
    && Number(reserve.protectedRepairTurnsRemaining) <= 2
    && Number(reserve.protectedToolCallsRemaining) <= 4);
}

function isPercentage(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value)
    && Number(value) >= minimum
    && Number(value) <= maximum;
}

export function isAssuranceResourcePolicyV1(
  value: unknown
): value is AssuranceResourcePolicyV1 {
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

function validAssurancePolicyV2(
  reserve: Record<string, unknown>,
  strategistCapacity: number
): boolean {
  return isAssuranceResourcePolicyV1(reserve)
    && isNonNegativeInteger(reserve.maxAuxiliaryCalls)
    && Number(reserve.maxAuxiliaryCalls)
      === Number(reserve.reviewRounds) * Number(reserve.reviewerMaxTurns)
        + strategistCapacity
    && Number(reserve.maxAuxiliaryBudgetBps) === Number(reserve.budgetPercent) * 100;
}

function validAssuranceUsageV2(
  reserve: Record<string, unknown>,
  strategistCapacity: number
): boolean {
  return [
    reserve.strategistCalls,
    reserve.reviewerCalls,
    reserve.repairEpisodes,
    reserve.auxiliaryInputTokens,
    reserve.auxiliaryOutputTokens,
    reserve.auxiliaryCostMicroUsd
  ].every(isNonNegativeInteger)
    && Number(reserve.strategistCalls) <= strategistCapacity
    && Number(reserve.reviewerCalls) <= Number(reserve.reviewRounds)
    && Number(reserve.repairEpisodes) <= Number(reserve.repairRounds);
}

function validAssuranceRepairReserveV2(
  reserve: Record<string, unknown>
): boolean {
  return [
    reserve.protectedRepairTurnsRemaining,
    reserve.protectedToolCallsRemaining
  ].every(isNonNegativeInteger)
    && Number(reserve.protectedRepairTurnsRemaining)
      <= Number(reserve.repairRounds) * Number(reserve.repairMaxTurns)
    && Number(reserve.protectedToolCallsRemaining)
      <= Number(reserve.repairRounds) * Number(reserve.repairMaxToolCalls);
}

export function isAssuranceReserveStateV2(value: unknown): value is AssuranceReserveStateV2 {
  const reserve = record(value);
  if (!reserve || reserve.schemaVersion !== 2) return false;
  const strategistCapacity = reserve.strategistMode === "off" ? 0 : 1;
  return validAssurancePolicyV2(reserve, strategistCapacity)
    && validAssuranceUsageV2(reserve, strategistCapacity)
    && validAssuranceRepairReserveV2(reserve);
}

function isLongHorizonActionOutcomeV1(value: unknown): value is LongHorizonActionOutcomeV1 {
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

function validLongHorizonCounters(state: Record<string, unknown>): boolean {
  const counters = [
    state.goalEpoch,
    state.settledBatchCount,
    state.noProgressBatches,
    state.maxNoProgressBatches,
    state.mutationBatchesWithoutValidation
  ];
  return counters.every(isNonNegativeInteger)
    && Number(state.maxNoProgressBatches) >= Number(state.noProgressBatches);
}

function validLongHorizonStrategy(state: Record<string, unknown>): boolean {
  return (state.checkpointBasisDigest === undefined
      || isDigest(state.checkpointBasisDigest))
    && (state.strategy === undefined || isStrategyResetV1(state.strategy))
    && (state.strategyResetBatchCount === undefined
      || isNonNegativeInteger(state.strategyResetBatchCount))
    && typeof state.actionRequiredConsumed === "boolean";
}

export function isLongHorizonStateV1(value: unknown): value is LongHorizonStateV1 {
  const state = record(value);
  if (!state || state.schemaVersion !== 1) return false;
  return validLongHorizonCounters(state)
    && isDigest(state.progressBasisDigest)
    && Array.isArray(state.recentOutcomes)
    && state.recentOutcomes.length <= 8
    && state.recentOutcomes.every(isLongHorizonActionOutcomeV1)
    && [
      "normal",
      "checkpoint",
      "strategy_required",
      "strategy_reset",
      "action_required"
    ].includes(String(state.stage))
    && typeof state.validationDue === "boolean"
    && validLongHorizonStrategy(state)
    && isAssuranceReserveStateV1(state.assurance);
}

export function isLongHorizonStateV2(value: unknown): value is LongHorizonStateV2 {
  const state = record(value);
  return Boolean(state
    && state.schemaVersion === 2
    && isNonNegativeInteger(state.goalEpoch)
    && isNonNegativeInteger(state.settledBatchCount)
    && Array.isArray(state.recentOutcomes)
    && state.recentOutcomes.length <= 8
    && state.recentOutcomes.every(isLongHorizonActionOutcomeV1)
    && isNonNegativeInteger(state.duplicateStreak)
    && Number(state.duplicateStreak) <= Number(state.settledBatchCount)
    && typeof state.strategyRequested === "boolean"
    && typeof state.resourceBandTriggered === "boolean"
    && (state.strategy === undefined || isStrategyResetV2(state.strategy))
    && isAssuranceReserveStateV2(state.assurance));
}

export function isToolResultPruneStateV1(value: unknown): value is ToolResultPruneStateV1 {
  const state = record(value);
  return Boolean(state
    && state.schemaVersion === 1
    && Number.isSafeInteger(state.coveredBlocks)
    && Number(state.coveredBlocks) >= 0
    && isDigest(state.sourceDigest)
    && (state.archiveSourceDigest === undefined
      || isDigest(state.archiveSourceDigest)));
}

export function isReasoningTrajectoryStateV1(
  value: unknown
): value is ReasoningTrajectoryStateV1 {
  const state = record(value);
  return Boolean(state
    && state.schemaVersion === 1
    && Array.isArray(state.blockDigests)
    && state.blockDigests.length <= 1_024
    && state.blockDigests.every(isDigest)
    && new Set(state.blockDigests as string[]).size === state.blockDigests.length
    && isDigest(state.sourceDigest));
}
