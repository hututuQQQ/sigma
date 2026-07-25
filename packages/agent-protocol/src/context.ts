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

export interface ContextArchive {
  schemaVersion: 1;
  item: ContextItem;
  omittedHistoryTurns: number;
  sourceDigest: string;
}

export type RuntimeBudgetBand = 100 | 50 | 25 | 10 | 0;

export interface RuntimePromptState {
  schemaVersion: 1;
  sectionDigests: {
    repository?: string;
    completion?: string;
    plan?: string;
    budget?: string;
    longHorizon?: string;
  };
  budgetBand: RuntimeBudgetBand;
  archiveSourceDigest?: string;
}

export interface ToolResultPruneState {
  schemaVersion: 1;
  coveredBlocks: number;
  sourceDigest: string;
  archiveSourceDigest?: string;
}

export interface ReasoningTrajectoryState {
  schemaVersion: 1;
  blockDigests: string[];
  sourceDigest: string;
}

export interface StrategyReset {
  schemaVersion: 1;
  basisDigest: string;
  establishedFacts: string[];
  falsifiedApproaches: string[];
  hypothesis: string;
  nextDiscriminatingAction: string;
  expectedSignal: string;
  validationTarget?: string;
  decision:
    | "continue_exploring"
    | "implement_candidate"
    | "revise_plan"
    | "validate_current"
    | "request_user_input";
  decisionRationale: string;
  trigger:
    | "model_request"
    | "input_request"
    | "duplicate_result"
    | "evidence_window"
    | "resource_band";
}

export interface LongHorizonActionOutcome {
  batch: number;
  toolNames: string[];
  callDigest: string;
  resultDigest: string;
  summary: string;
}

export type AssuranceStrategistMode = "off" | "on_demand" | "adaptive";

export interface AssuranceResourcePolicy {
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

export interface AssuranceReserveState extends AssuranceResourcePolicy {
  schemaVersion: 1;
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

export interface LongHorizonState {
  schemaVersion: 1;
  goalEpoch: number;
  settledBatchCount: number;
  recentOutcomes: LongHorizonActionOutcome[];
  duplicateStreak: number;
  strategyRequested: boolean;
  resourceBandTriggered: boolean;
  strategy?: StrategyReset;
  assurance: AssuranceReserveState;
}

export const DEFAULT_ASSURANCE_RESOURCE_POLICY: Readonly<AssuranceResourcePolicy> = {
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

export function emptyRuntimePromptState(): RuntimePromptState {
  return {
    schemaVersion: 1,
    sectionDigests: {},
    budgetBand: 100
  };
}

export function emptyLongHorizonState(
  policy: AssuranceResourcePolicy = DEFAULT_ASSURANCE_RESOURCE_POLICY
): LongHorizonState {
  const strategistCapacity = policy.strategistMode === "off" ? 0 : 1;
  return {
    schemaVersion: 1,
    goalEpoch: 0,
    settledBatchCount: 0,
    recentOutcomes: [],
    duplicateStreak: 0,
    strategyRequested: false,
    resourceBandTriggered: false,
    assurance: {
      schemaVersion: 1,
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

export function emptyReasoningTrajectoryState(): ReasoningTrajectoryState {
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

export function isContextArchive(value: unknown): value is ContextArchive {
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

export function isRuntimePromptState(value: unknown): value is RuntimePromptState {
  const state = record(value);
  const sections = record(state?.sectionDigests);
  if (!state || state.schemaVersion !== 1 || !sections) return false;
  const allowed = new Set(["repository", "completion", "plan", "budget", "longHorizon"]);
  if (Object.keys(sections).some((key) => !allowed.has(key))) return false;
  return [sections.repository, sections.completion, sections.plan, sections.budget, sections.longHorizon]
    .every((digest) => digest === undefined || isDigest(digest))
    && [100, 50, 25, 10, 0].includes(Number(state.budgetBand))
    && (state.archiveSourceDigest === undefined || isDigest(state.archiveSourceDigest));
}

export {
  isAssuranceResourcePolicy,
  isAssuranceReserveState,
  isLongHorizonState,
  isReasoningTrajectoryState,
  isStrategyReset,
  isToolResultPruneState
} from "./context-guards.js";

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  toolTokens: number;
  systemTokens: number;
  dynamicTokens: number;
  historyTokens: number;
}
