import type {
  BudgetAmounts,
  LongHorizonState,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  StrategyReset
} from "agent-protocol";
import { MAX_STRATEGIST_CALLS } from "agent-protocol";
import type { ModelRouteConstraints } from "agent-model";
import {
  availableAuxiliaryBudget,
  rawAvailableBudget
} from "./assurance-budget.js";
import {
  evidenceAttentionWindow,
  longHorizonDigest,
  longHorizonProgressBasisDigest,
  longHorizonRelevantEvidence
} from "./long-horizon-state.js";
import type { RuntimeSession } from "./types.js";

export type StrategyTrigger = StrategyReset["trigger"];

const MAXIMUM_STRATEGY_USER_INSTRUCTION_CHARS = 24_000;
const MAXIMUM_STRATEGY_EVIDENCE_ITEMS = 12;

function boundedUserInstructions(session: RuntimeSession): string[] {
  const messages = session.durable.state.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .slice(-8);
  let remaining = MAXIMUM_STRATEGY_USER_INSTRUCTION_CHARS;
  const selected: string[] = [];
  for (const content of [...messages].reverse()) {
    if (remaining <= 0) break;
    const limit = Math.min(12_000, remaining);
    const bounded = content.length <= limit
      ? content
      : `${content.slice(0, Math.max(0, limit - 12))}\n[truncated]`;
    selected.push(bounded);
    remaining -= bounded.length;
  }
  return selected.reverse();
}

export function strategyMessages(
  session: RuntimeSession,
  trigger: StrategyTrigger
): ModelMessage[] {
  const state = session.durable.state;
  const frontier = state.mutationFrontier;
  const attention = evidenceAttentionWindow(session);
  const recentOutcomes = state.longHorizon.recentOutcomes.slice(-8);
  const recentOutcomeKeys = new Set(recentOutcomes.map((outcome) =>
    `${outcome.callDigest}:${outcome.resultDigest}`));
  const olderRepresentativeOutcomes = attention.representativeOutcomes
    .filter((outcome) => !recentOutcomeKeys.has(
      `${outcome.callDigest}:${outcome.resultDigest}`
    ));
  return [{
    role: "system",
    content: [
      "You are Sigma's fresh-context long-horizon strategist.",
      "A strategy reset was requested by the main model, a proposed user-input suspension, consecutive settled batches without durable marginal progress, a bounded evidence-attention window, or an objective resource band.",
      "Use only the supplied user instructions, checklist, mutation frontier, evidence, and bounded receipt summaries.",
      "Receipt summaries are ordered oldest to newest. Treat recentOutcomes as the authoritative current window; when an older evidence-attention summary conflicts with a newer receipt, use the newer receipt.",
      "When priorStrategy is present, it is historical anti-loop memory rather than a standing instruction. Account for its established facts, do not repeat a falsified route without newer contradictory evidence, and revise its recommendation when later receipts did not produce progress.",
      "The runtime cannot judge task semantics. Decide whether the evidence supports more exploration, implementing the best current candidate, revising the plan, validating the current result, or requesting user input.",
      "For an input_request trigger, recommend request_user_input only when the missing item is genuinely a user-owned choice or fact that cannot be derived from the durable instructions, workspace, available evidence, or a reasonable best-effort default. Otherwise provide the smallest discriminating action or plan pivot.",
      "Do not solve the task, call tools, mention elapsed time, infer hidden evaluation context, or invent facts.",
      "Return strict JSON with exactly: establishedFacts (0-12 strings), falsifiedApproaches (0-8 strings), hypothesis (non-empty string), decision (continue_exploring | implement_candidate | revise_plan | validate_current | request_user_input), decisionRationale (non-empty string), nextDiscriminatingAction (non-empty string), expectedSignal (non-empty string), and optional validationTarget."
    ].join(" ")
  }, {
    role: "user",
    content: JSON.stringify({
      trigger,
      userInstructions: boundedUserInstructions(session),
      priorStrategy: state.longHorizon.strategy ? {
        trigger: state.longHorizon.strategy.trigger,
        decision: state.longHorizon.strategy.decision ?? null,
        establishedFacts: state.longHorizon.strategy.establishedFacts,
        falsifiedApproaches: state.longHorizon.strategy.falsifiedApproaches,
        hypothesis: state.longHorizon.strategy.hypothesis,
        nextDiscriminatingAction: state.longHorizon.strategy.nextDiscriminatingAction,
        expectedSignal: state.longHorizon.strategy.expectedSignal
      } : null,
      plan: {
        goal: state.plan.goal,
        activeNodeId: state.plan.activeNodeId ?? null,
        nodes: state.plan.nodes.map((node) => ({
          id: node.id,
          step: node.title,
          status: node.status,
          blockedReason: node.blockedReason ?? null,
          acceptanceCriteria: node.acceptanceCriteria
        }))
      },
      frontier: {
        revision: frontier.revision,
        currentStateDigest: frontier.currentStateDigest,
        changedPathCount: frontier.changedPaths.length,
        representativePaths: [...frontier.changedPaths].sort().slice(0, 32),
        changedPathsDigest: longHorizonDigest([...frontier.changedPaths].sort()),
        environmentChangedPathCount: frontier.environmentChangedPaths?.length ?? 0,
        representativeEnvironmentPaths:
          [...(frontier.environmentChangedPaths ?? [])].sort().slice(0, 32),
        environmentChangedPathsDigest:
          longHorizonDigest([...(frontier.environmentChangedPaths ?? [])].sort())
      },
      evidence: longHorizonRelevantEvidence(session).slice(-MAXIMUM_STRATEGY_EVIDENCE_ITEMS),
      recentOutcomes,
      evidenceAttention: {
        tokenCount: attention.tokenCount,
        tokenLimit: attention.tokenLimit,
        batchCount: attention.batchCount,
        outcomeDigest: attention.outcomeDigest,
        representativeOutcomes: olderRepresentativeOutcomes
      }
    })
  }];
}

function stringArray(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum
    || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    return undefined;
  }
  return value.map((item) => String(item).trim());
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsedStrategyDecision(
  record: Record<string, unknown>
): Pick<StrategyReset, "decision" | "decisionRationale"> | undefined {
  const allowed = [
    "continue_exploring",
    "implement_candidate",
    "revise_plan",
    "validate_current",
    "request_user_input"
  ] as const;
  const decision = typeof record.decision === "string"
    ? allowed.find((value) => value === record.decision)
    : undefined;
  const decisionRationale = nonemptyString(record.decisionRationale);
  return decision && decisionRationale
    ? { decision, decisionRationale }
    : undefined;
}

function parsedStrategyFields(
  value: unknown
): Omit<StrategyReset, "schemaVersion" | "basisDigest" | "trigger"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "establishedFacts",
    "falsifiedApproaches",
    "hypothesis",
    "decision",
    "decisionRationale",
    "nextDiscriminatingAction",
    "expectedSignal",
    "validationTarget"
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  const establishedFacts = stringArray(record.establishedFacts, 12);
  const falsifiedApproaches = stringArray(record.falsifiedApproaches, 8);
  const hypothesis = nonemptyString(record.hypothesis);
  const decision = parsedStrategyDecision(record);
  const nextDiscriminatingAction = nonemptyString(record.nextDiscriminatingAction);
  const expectedSignal = nonemptyString(record.expectedSignal);
  const validationTarget = record.validationTarget === undefined
    ? undefined
    : nonemptyString(record.validationTarget);
  if (!establishedFacts || !falsifiedApproaches || !hypothesis
    || !decision
    || !nextDiscriminatingAction || !expectedSignal
    || (record.validationTarget !== undefined && !validationTarget)) return undefined;
  return {
    establishedFacts,
    falsifiedApproaches,
    hypothesis,
    ...decision,
    nextDiscriminatingAction,
    expectedSignal,
    ...(validationTarget ? { validationTarget } : {})
  };
}

export function parsedStrategy(
  content: string,
  basisDigest: string,
  trigger: StrategyTrigger
): StrategyReset | undefined {
  try {
    const value = JSON.parse(content.trim()) as unknown;
    const fields = parsedStrategyFields(value);
    if (!fields) return undefined;
    return {
      schemaVersion: 1,
      basisDigest,
      ...fields,
      trigger
    };
  } catch {
    return undefined;
  }
}

export function fallbackStrategy(
  state: LongHorizonState,
  basisDigest: string,
  trigger: StrategyTrigger,
  reason: string
): StrategyReset {
  return {
    schemaVersion: 1,
    basisDigest,
    establishedFacts: state.recentOutcomes.slice(-4).map((item) => item.summary)
      .filter((item) => item.length > 0),
    falsifiedApproaches: [],
    hypothesis: reason,
    decision: "revise_plan",
    decisionRationale:
      "The fresh semantic judgement was unavailable, so the main model should consolidate the durable evidence before spending another attention window.",
    nextDiscriminatingAction:
      "Choose the smallest tool action whose result can distinguish the current hypothesis.",
    expectedSignal:
      "The result rules the hypothesis in or out without repeating the same call and result.",
    validationTarget:
      "Identify the strongest practical check for the change once the implementation is ready.",
    trigger
  };
}

function strategyTriggerCandidates(
  session: RuntimeSession,
  state: LongHorizonState
): StrategyTrigger[] {
  const candidates: StrategyTrigger[] = [];
  if (state.strategyRequested) {
    candidates.push(state.recentOutcomes.at(-1)?.toolNames.includes("request_user_input")
      ? "input_request"
      : "model_request");
  }
  if (state.assurance.strategistMode !== "adaptive") return candidates;
  // The first observation establishes a result baseline. Match OpenCode's
  // three-call doom-loop boundary by resetting after the following two
  // no-progress batches under the default duplicateThreshold=3 policy.
  const noProgressThreshold = Math.max(2, state.assurance.duplicateThreshold - 1);
  if (state.duplicateStreak >= noProgressThreshold) candidates.push("duplicate_result");
  if (evidenceAttentionWindow(session).saturated) candidates.push("evidence_window");
  if (state.resourceBandTriggered) candidates.push("resource_band");
  return [...new Set(candidates)];
}

export function strategistTrigger(session: RuntimeSession): StrategyTrigger | undefined {
  const state = session.durable.state.longHorizon;
  if (state.assurance.strategistCalls >= MAX_STRATEGIST_CALLS
    || state.assurance.strategistMode === "off") return undefined;
  const strategyCurrent = state.strategy?.basisDigest
    === longHorizonProgressBasisDigest(session);
  if (strategyCurrent) return undefined;
  const candidates = strategyTriggerCandidates(session, state);
  if (state.assurance.strategistCalls === 0) return candidates[0];
  // The second bounded call must address a distinct objective signal. This
  // catches a later doom loop after an earlier resource checkpoint (and vice
  // versa) without repeatedly asking for the same semantic judgement.
  return candidates.find((candidate) => candidate !== state.strategy?.trigger);
}

export function strategyBasisDigest(session: RuntimeSession): string {
  // A fresh strategy guides exactly the next main-model action. Once that
  // action settles, its receipt changes the progress basis and the strategy
  // becomes historical anti-loop memory instead of a standing instruction.
  return longHorizonProgressBasisDigest(session);
}

export function auxiliaryCapacity(
  session: RuntimeSession,
  desired: BudgetAmounts
): BudgetAmounts | undefined {
  const state = session.durable.state.longHorizon;
  const raw = rawAvailableBudget(session);
  const available = availableAuxiliaryBudget(session);
  const protectedReviewerCalls = Math.max(
    0,
    state.assurance.reviewRounds - state.assurance.reviewerCalls
  ) * state.assurance.reviewerMaxTurns;
  const protectedMainTurns = state.assurance.protectedRepairTurnsRemaining;
  if (raw.modelTurns < 1 + protectedReviewerCalls + protectedMainTurns) return undefined;
  return (["inputTokens", "outputTokens", "costMicroUsd"] as const)
    .every((dimension) =>
      desired[dimension] * (1 + protectedReviewerCalls) <= available[dimension])
    && available.modelTurns >= 1
    ? { ...available, modelTurns: 1 }
    : undefined;
}

export function fullAmounts(value: Partial<BudgetAmounts>): BudgetAmounts {
  return {
    inputTokens: value.inputTokens ?? 0,
    outputTokens: value.outputTokens ?? 0,
    costMicroUsd: value.costMicroUsd ?? 0,
    modelTurns: value.modelTurns ?? 0,
    toolCalls: value.toolCalls ?? 0,
    children: value.children ?? 0
  };
}

export function constrainedGateway(gateway: ModelGateway): ModelGateway & {
  completeWithConstraints?: (
    request: ModelRequest,
    constraints: ModelRouteConstraints
  ) => Promise<ModelResponse>;
} {
  return gateway;
}
