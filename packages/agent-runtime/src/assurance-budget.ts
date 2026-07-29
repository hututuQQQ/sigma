import type { BudgetAmounts } from "agent-protocol";
import { mutationFrontierHasChanges } from "agent-kernel";
import type { RuntimeSession } from "./types.js";

const BUDGET_BPS = 10_000;

export interface CurrentAuxiliaryUsage {
  strategistCalls: number;
  reviewerCalls: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

/**
 * Derive enforcement accounting from durable usage rather than the cached
 * long-horizon projection. This closes the window between an auxiliary call
 * settling and the next long-horizon refresh (for example, two explicit
 * review requests in one tool batch).
 */
export function currentAuxiliaryUsage(session: RuntimeSession): CurrentAuxiliaryUsage {
  const usage = session.durable.state.usage.filter((item) =>
    item.runId === session.durable.runId
    && ((item.role === "planner" && item.requestId.startsWith("strategy:"))
      || item.role === "reviewer"));
  const strategist = new Set(usage.filter((item) =>
    item.role === "planner" && item.requestId.startsWith("strategy:"))
    .map((item) => item.requestId));
  const reviewers = new Set(usage.filter((item) => item.role === "reviewer")
    .map((item) => item.requestId));
  return {
    strategistCalls: strategist.size,
    reviewerCalls: reviewers.size,
    modelTurns: usage.reduce((total, item) =>
      total + Math.max(1, item.attempt), 0),
    inputTokens: usage.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: usage.reduce((total, item) => total + item.outputTokens, 0),
    costMicroUsd: usage.reduce((total, item) => total + (item.costMicroUsd ?? 0), 0)
  };
}

export function rawAvailableBudget(session: RuntimeSession): BudgetAmounts {
  const ledger = session.durable.state.budget;
  return {
    inputTokens: Math.max(0,
      ledger.limits.inputTokens - ledger.consumed.inputTokens - ledger.reserved.inputTokens),
    outputTokens: Math.max(0,
      ledger.limits.outputTokens - ledger.consumed.outputTokens - ledger.reserved.outputTokens),
    costMicroUsd: Math.max(0,
      ledger.limits.costMicroUsd - ledger.consumed.costMicroUsd - ledger.reserved.costMicroUsd),
    modelTurns: Math.max(0,
      ledger.limits.modelTurns - ledger.consumed.modelTurns - ledger.reserved.modelTurns),
    toolCalls: Math.max(0,
      ledger.limits.toolCalls - ledger.consumed.toolCalls - ledger.reserved.toolCalls),
    children: Math.max(0,
      ledger.limits.children - ledger.consumed.children - ledger.reserved.children)
  };
}

function substantiveReviewRoundsUsed(session: RuntimeSession): number {
  return session.durable.state.evidence.filter((evidence) =>
    evidence.kind === "review"
    && evidence.runId === session.durable.runId
    && evidence.data.failureKind === undefined
    && !["review_scope_too_large", "review_protocol_invalid", "review_unavailable"]
      .includes(evidence.data.failureCode ?? "")).length;
}

function bindingAssuranceRequired(session: RuntimeSession): boolean {
  return (session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory")
    === "required";
}

/**
 * Bound the reserve by assurance work that can still legally run. The global
 * auxiliary turn ceiling is intentionally conservative, but unused turns from
 * an already-settled strategist or final review are not future capacity and
 * must not strand the ordinary solver's remaining token/cost budget.
 */
function remainingAuxiliaryTurnCapacity(
  session: RuntimeSession,
  usage: CurrentAuxiliaryUsage
): number {
  const assurance = session.durable.state.longHorizon.assurance;
  const remainingGlobal = Math.max(
    0,
    assurance.maxAuxiliaryCalls - usage.modelTurns
  );
  const remainingReviewRounds = Math.max(
    0,
    assurance.reviewRounds - substantiveReviewRoundsUsed(session)
  );
  const reviewerCapacity = remainingReviewRounds * assurance.reviewerMaxTurns;
  const strategistCapacity = assurance.strategistMode !== "off"
    && usage.strategistCalls < 1 ? 1 : 0;
  return Math.min(
    remainingGlobal,
    reviewerCapacity + strategistCapacity
  );
}

export function availableAuxiliaryBudget(session: RuntimeSession): BudgetAmounts {
  const raw = rawAvailableBudget(session);
  const ledger = session.durable.state.budget;
  const assurance = session.durable.state.longHorizon.assurance;
  const usage = currentAuxiliaryUsage(session);
  const remainingTurns = remainingAuxiliaryTurnCapacity(session, usage);
  const cap = {
    inputTokens: Math.floor(
      ledger.limits.inputTokens * assurance.maxAuxiliaryBudgetBps / BUDGET_BPS
    ),
    outputTokens: Math.floor(
      ledger.limits.outputTokens * assurance.maxAuxiliaryBudgetBps / BUDGET_BPS
    ),
    costMicroUsd: Math.floor(
      ledger.limits.costMicroUsd * assurance.maxAuxiliaryBudgetBps / BUDGET_BPS
    )
  };
  if (remainingTurns <= 0) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      modelTurns: 0,
      toolCalls: 0,
      children: 0
    };
  }
  return {
    inputTokens: Math.min(raw.inputTokens,
      Math.max(0, cap.inputTokens - usage.inputTokens)),
    outputTokens: Math.min(raw.outputTokens,
      Math.max(0, cap.outputTokens - usage.outputTokens)),
    costMicroUsd: Math.min(raw.costMicroUsd,
      Math.max(0, cap.costMicroUsd - usage.costMicroUsd)),
    modelTurns: Math.min(raw.modelTurns, remainingTurns),
    toolCalls: 0,
    children: 0
  };
}

function futureRepairReserveRequired(session: RuntimeSession): boolean {
  if (!bindingAssuranceRequired(session)) return false;
  const assurance = session.durable.state.longHorizon.assurance;
  if (assurance.repairRounds <= 0) return false;
  if (reviewRepairActive(session)) return true;
  const reviews = substantiveReviewRoundsUsed(session);
  if (reviews > 0 || reviews >= assurance.reviewRounds) return false;
  return true;
}

export interface MainBudgetWindow {
  available: BudgetAmounts;
  capacity: BudgetAmounts;
}

/**
 * Report the main loop's resource window after removing capacity that belongs
 * to strategist/reviewer calls and review repair. Resource-band decisions must
 * use this window, not the raw session ledger: waiting until 25% of the raw
 * ledger remains leaves only 5% for the main loop when assurance owns 20%.
 */
export function mainBudgetWindow(session: RuntimeSession): MainBudgetWindow {
  const raw = rawAvailableBudget(session);
  const limits = session.durable.state.budget.limits;
  if (!bindingAssuranceRequired(session)) {
    return {
      available: raw,
      capacity: {
        inputTokens: limits.inputTokens,
        outputTokens: limits.outputTokens,
        costMicroUsd: limits.costMicroUsd,
        modelTurns: limits.modelTurns,
        toolCalls: limits.toolCalls,
        children: limits.children
      }
    };
  }
  const assurance = session.durable.state.longHorizon.assurance;
  const auxiliary = availableAuxiliaryBudget(session);
  const protectRepair = futureRepairReserveRequired(session);
  const auxiliaryCaps = {
    inputTokens: Math.floor(
      limits.inputTokens * assurance.maxAuxiliaryBudgetBps / BUDGET_BPS
    ),
    outputTokens: Math.floor(
      limits.outputTokens * assurance.maxAuxiliaryBudgetBps / BUDGET_BPS
    ),
    costMicroUsd: Math.floor(
      limits.costMicroUsd * assurance.maxAuxiliaryBudgetBps / BUDGET_BPS
    )
  };
  const repairTurnCapacity = assurance.repairRounds * assurance.repairMaxTurns;
  const repairToolCapacity = assurance.repairRounds * assurance.repairMaxToolCalls;
  return {
    available: {
      inputTokens: Math.max(0, raw.inputTokens - auxiliary.inputTokens),
      outputTokens: Math.max(0, raw.outputTokens - auxiliary.outputTokens),
      costMicroUsd: Math.max(0, raw.costMicroUsd - auxiliary.costMicroUsd),
      modelTurns: Math.max(
        0,
        raw.modelTurns
          - auxiliary.modelTurns
          - (protectRepair ? assurance.protectedRepairTurnsRemaining : 0)
      ),
      toolCalls: Math.max(
        0,
        raw.toolCalls
          - (protectRepair ? assurance.protectedToolCallsRemaining : 0)
      ),
      children: raw.children
    },
    capacity: {
      inputTokens: Math.max(0, limits.inputTokens - auxiliaryCaps.inputTokens),
      outputTokens: Math.max(0, limits.outputTokens - auxiliaryCaps.outputTokens),
      costMicroUsd: Math.max(0, limits.costMicroUsd - auxiliaryCaps.costMicroUsd),
      modelTurns: Math.max(
        0,
        limits.modelTurns - assurance.maxAuxiliaryCalls - repairTurnCapacity
      ),
      toolCalls: Math.max(0, limits.toolCalls - repairToolCapacity),
      children: limits.children
    }
  };
}

export function reviewRepairActive(session: RuntimeSession): boolean {
  const reviews = session.durable.state.evidence.filter((evidence) =>
    evidence.kind === "review"
    && evidence.runId === session.durable.runId
    && evidence.data.failureKind === undefined
    && !["review_scope_too_large", "review_protocol_invalid", "review_unavailable"]
      .includes(evidence.data.failureCode ?? ""));
  const latest = reviews.at(-1);
  const assurance = session.durable.state.longHorizon.assurance;
  return Boolean(latest
    && latest.kind === "review"
    && latest.status === "failed"
    && latest.data.verdict !== "approved"
    && reviews.length <= assurance.repairRounds);
}

function proportionalShare(
  total: number,
  ownUnits: number,
  allUnits: number
): number {
  if (total <= 0 || ownUnits <= 0 || allUnits <= 0) return 0;
  return Math.floor(total * ownUnits / allUnits);
}

/**
 * Required-review profiles keep binding reviewer and repair capacity isolated
 * once a mutation frontier exists. Advisory/off profiles may still invoke
 * capped auxiliary work, but optional assurance cannot reduce the advertised
 * main-loop hard limits or turn a normal solve into an early resource failure.
 * During an actual review repair, the protected values become guaranteed
 * reserve floors, not an episode ceiling: the repair may continue through the
 * ordinary main-loop budget while the remaining reviewer pool stays isolated.
 */
export function availableOrchestratorBudget(session: RuntimeSession): BudgetAmounts {
  const raw = rawAvailableBudget(session);
  if (!mutationFrontierHasChanges(session.durable.state.mutationFrontier)
    || !bindingAssuranceRequired(session)) return raw;
  const auxiliary = availableAuxiliaryBudget(session);
  const assurance = session.durable.state.longHorizon.assurance;
  const repair = reviewRepairActive(session);
  const protectFutureRepair = futureRepairReserveRequired(session);
  const protectedAuxiliaryTurns = Math.min(raw.modelTurns, auxiliary.modelTurns);
  const ordinaryModelTurns = Math.max(0, raw.modelTurns - protectedAuxiliaryTurns);
  const ordinaryToolCalls = raw.toolCalls;
  const repairUnits = repair
    ? assurance.protectedRepairTurnsRemaining
    : 0;
  const assuranceUnits = repairUnits + protectedAuxiliaryTurns;
  const ordinary = {
    inputTokens: Math.max(0, raw.inputTokens - auxiliary.inputTokens),
    outputTokens: Math.max(0, raw.outputTokens - auxiliary.outputTokens),
    costMicroUsd: Math.max(0, raw.costMicroUsd - auxiliary.costMicroUsd)
  };
  return {
    inputTokens: ordinary.inputTokens + proportionalShare(
      auxiliary.inputTokens,
      repairUnits,
      assuranceUnits
    ),
    outputTokens: ordinary.outputTokens + proportionalShare(
      auxiliary.outputTokens,
      repairUnits,
      assuranceUnits
    ),
    costMicroUsd: ordinary.costMicroUsd + proportionalShare(
      auxiliary.costMicroUsd,
      repairUnits,
      assuranceUnits
    ),
    modelTurns: repair
      ? ordinaryModelTurns
      : Math.max(
          0,
          ordinaryModelTurns
            - (protectFutureRepair ? assurance.protectedRepairTurnsRemaining : 0)
        ),
    toolCalls: repair
      ? ordinaryToolCalls
      : Math.max(
          0,
          ordinaryToolCalls
            - (protectFutureRepair ? assurance.protectedToolCallsRemaining : 0)
        ),
    children: raw.children
  };
}
