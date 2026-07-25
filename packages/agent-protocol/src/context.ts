import type { ContextAuthority } from "./events.js";

export interface ContextItem {
  id: string;
  authority: Exclude<ContextAuthority, "external_verifier">;
  provenance: string;
  content: string;
  tokenCount: number;
  priority: number;
  cacheKey?: string;
}

/**
 * Durable semantic replacement for a stable, omitted history prefix.
 *
 * The original event log remains authoritative and is never deleted. The
 * archive is only a model-context projection, so it deliberately carries no
 * system/developer/user authority of its own.
 */
export interface ContextArchiveV1 {
  schemaVersion: 1;
  item: ContextItem;
  omittedHistoryTurns: number;
  sourceDigest: string;
}

export type RuntimeBudgetBand = 100 | 50 | 25 | 10 | 0;

/**
 * Durable record of the runtime-owned state sections already materialized
 * into model history. Each section remains effective until a later update for
 * the same section appears.
 */
export interface RuntimePromptStateV2 {
  schemaVersion: 2;
  sectionDigests: {
    repository?: string;
    completion?: string;
    plan?: string;
    budget?: string;
    longHorizon?: string;
  };
  budgetBand: RuntimeBudgetBand;
  /** A changed archive means the next request must restate every section. */
  archiveSourceDigest?: string;
}

export interface ToolResultPruneStateV1 {
  schemaVersion: 1;
  coveredBlocks: number;
  sourceDigest: string;
  archiveSourceDigest?: string;
}

export interface ReasoningTrajectoryStateV1 {
  schemaVersion: 1;
  /** Digests of complete assistant/tool blocks that cannot be replayed under
   * the current provider's reasoning protocol. */
  blockDigests: string[];
  sourceDigest: string;
}

export type LongHorizonStage =
  | "normal"
  | "checkpoint"
  | "strategy_required"
  | "strategy_reset"
  | "action_required";

export interface StrategyResetActionV1 {
  title: string;
  expectedSignal: string;
  kind: "inspect" | "change" | "validate" | "ask";
}

/**
 * A bounded, task-state-driven strategy reset produced from a fresh model
   * context. It contains no evaluator identity, post-run scoring output, or
   * wall-clock deadline information.
 */
export interface StrategyResetV1 {
  schemaVersion: 1;
  basisDigest: string;
  establishedFacts: string[];
  lowYieldApproaches: string[];
  hypothesis: string;
  nextActions: StrategyResetActionV1[];
  validationTarget?: string;
}

export interface StrategyResetV2 {
  schemaVersion: 2;
  basisDigest: string;
  establishedFacts: string[];
  falsifiedApproaches: string[];
  hypothesis: string;
  nextDiscriminatingAction: string;
  expectedSignal: string;
  validationTarget?: string;
  /**
   * New strategy resets make the semantic recommendation explicit. These
   * fields remain optional only so V10 snapshots can be restored without
   * inventing a model judgement that was never made.
   */
  decision?:
    | "continue_exploring"
    | "implement_candidate"
    | "revise_plan"
    | "validate_current"
    | "request_user_input";
  decisionRationale?: string;
  trigger:
    | "model_request"
    | "input_request"
    | "duplicate_result"
    | "evidence_window"
    | "resource_band";
}

export interface LongHorizonActionOutcomeV1 {
  batch: number;
  toolNames: string[];
  callDigest: string;
  resultDigest: string;
  summary: string;
}

export interface AssuranceReserveStateV1 {
  schemaVersion: 1;
  maxAuxiliaryCalls: 3;
  maxAuxiliaryBudgetBps: 2000;
  strategistCalls: number;
  reviewerCalls: number;
  auxiliaryInputTokens: number;
  auxiliaryOutputTokens: number;
  auxiliaryCostMicroUsd: number;
  protectedRepairTurnsRemaining: number;
  protectedToolCallsRemaining: number;
}

export type AssuranceStrategistMode = "off" | "on_demand" | "adaptive";

export interface AssuranceResourcePolicyV1 {
  budgetPercent: number;
  reviewRounds: number;
  repairRounds: number;
  reviewerMaxTurns: number;
  reviewerMaxToolCalls: number;
  repairMaxTurns: number;
  repairMaxToolCalls: number;
  strategistMode: AssuranceStrategistMode;
  duplicateThreshold: number;
  strategyRemainingPercent: number;
}

export interface AssuranceReserveStateV2 extends AssuranceResourcePolicyV1 {
  schemaVersion: 2;
  maxAuxiliaryCalls: number;
  maxAuxiliaryBudgetBps: number;
  strategistCalls: number;
  reviewerCalls: number;
  repairEpisodes: number;
  auxiliaryInputTokens: number;
  auxiliaryOutputTokens: number;
  auxiliaryCostMicroUsd: number;
  protectedRepairTurnsRemaining: number;
  protectedToolCallsRemaining: number;
}

/**
 * Durable control state for long-running work. Counters advance only when a
 * complete tool batch settles; model prose and elapsed wall-clock time do not
 * count as progress or convergence signals.
 */
export interface LongHorizonStateV1 {
  schemaVersion: 1;
  goalEpoch: number;
  progressBasisDigest: string;
  settledBatchCount: number;
  noProgressBatches: number;
  maxNoProgressBatches: number;
  mutationBatchesWithoutValidation: number;
  recentOutcomes: LongHorizonActionOutcomeV1[];
  stage: LongHorizonStage;
  validationDue: boolean;
  checkpointBasisDigest?: string;
  strategy?: StrategyResetV1;
  strategyResetBatchCount?: number;
  actionRequiredConsumed: boolean;
  assurance: AssuranceReserveStateV1;
}

/**
 * V10 long-horizon state persists only objective action repetition and
 * resource-band signals. Evidence-attention pressure is recomputed from the
 * durable trajectory, so it adds no task-semantic progress counter here.
 */
export interface LongHorizonStateV2 {
  schemaVersion: 2;
  goalEpoch: number;
  settledBatchCount: number;
  recentOutcomes: LongHorizonActionOutcomeV1[];
  duplicateStreak: number;
  strategyRequested: boolean;
  resourceBandTriggered: boolean;
  strategy?: StrategyResetV2;
  assurance: AssuranceReserveStateV2;
}

export const DEFAULT_ASSURANCE_RESOURCE_POLICY: Readonly<AssuranceResourcePolicyV1> = {
  budgetPercent: 20,
  reviewRounds: 2,
  repairRounds: 1,
  reviewerMaxTurns: 4,
  reviewerMaxToolCalls: 12,
  repairMaxTurns: 3,
  repairMaxToolCalls: 8,
  strategistMode: "adaptive",
  duplicateThreshold: 3,
  strategyRemainingPercent: 25
};

export function emptyRuntimePromptStateV2(): RuntimePromptStateV2 {
  return {
    schemaVersion: 2,
    sectionDigests: {},
    budgetBand: 100
  };
}

export function emptyLongHorizonStateV1(): LongHorizonStateV1 {
  return {
    schemaVersion: 1,
    goalEpoch: 0,
    progressBasisDigest: "0".repeat(64),
    settledBatchCount: 0,
    noProgressBatches: 0,
    maxNoProgressBatches: 0,
    mutationBatchesWithoutValidation: 0,
    recentOutcomes: [],
    stage: "normal",
    validationDue: false,
    actionRequiredConsumed: false,
    assurance: {
      schemaVersion: 1,
      maxAuxiliaryCalls: 3,
      maxAuxiliaryBudgetBps: 2000,
      strategistCalls: 0,
      reviewerCalls: 0,
      auxiliaryInputTokens: 0,
      auxiliaryOutputTokens: 0,
      auxiliaryCostMicroUsd: 0,
      protectedRepairTurnsRemaining: 2,
      protectedToolCallsRemaining: 4
    }
  };
}

export function emptyLongHorizonStateV2(
  policy: AssuranceResourcePolicyV1 = DEFAULT_ASSURANCE_RESOURCE_POLICY
): LongHorizonStateV2 {
  const strategistCapacity = policy.strategistMode === "off" ? 0 : 1;
  return {
    schemaVersion: 2,
    goalEpoch: 0,
    settledBatchCount: 0,
    recentOutcomes: [],
    duplicateStreak: 0,
    strategyRequested: false,
    resourceBandTriggered: false,
    assurance: {
      schemaVersion: 2,
      ...policy,
      maxAuxiliaryCalls:
        policy.reviewRounds * policy.reviewerMaxTurns + strategistCapacity,
      maxAuxiliaryBudgetBps: policy.budgetPercent * 100,
      strategistCalls: 0,
      reviewerCalls: 0,
      repairEpisodes: 0,
      auxiliaryInputTokens: 0,
      auxiliaryOutputTokens: 0,
      auxiliaryCostMicroUsd: 0,
      protectedRepairTurnsRemaining: policy.repairRounds * policy.repairMaxTurns,
      protectedToolCallsRemaining: policy.repairRounds * policy.repairMaxToolCalls
    }
  };
}

export function emptyReasoningTrajectoryStateV1(): ReasoningTrajectoryStateV1 {
  return {
    schemaVersion: 1,
    blockDigests: [],
    sourceDigest: "0".repeat(64)
  };
}

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
    && typeof archive.sourceDigest === "string"
    && /^[a-f0-9]{64}$/u.test(archive.sourceDigest)
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
  return [sections.repository, sections.completion, sections.plan, sections.budget, sections.longHorizon]
    .every((digest) => digest === undefined || isDigest(digest))
    && [100, 50, 25, 10, 0].includes(Number(state.budgetBand))
    && (state.archiveSourceDigest === undefined || isDigest(state.archiveSourceDigest));
}

export {
  isAssuranceReserveStateV2,
  isLongHorizonStateV1,
  isLongHorizonStateV2,
  isReasoningTrajectoryStateV1,
  isStrategyResetV1,
  isStrategyResetV2,
  isToolResultPruneStateV1
} from "./context-guards.js";

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  toolTokens: number;
  systemTokens: number;
  dynamicTokens: number;
  historyTokens: number;
}
