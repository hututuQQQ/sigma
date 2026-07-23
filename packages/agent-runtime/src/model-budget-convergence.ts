import type {
  BudgetAmounts,
  ContextItem,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
  RunOutcome,
  ToolDescriptor
} from "agent-protocol";
import type { ContextPlan } from "agent-context";
import { APPROXIMATE_TOKEN_RESERVATION_MARGIN } from "agent-model";
import {
  modelTools,
  projectModelToolDescriptors,
  providerSizedPlan,
  type ModelToolProjectionCapabilities
} from "./effect-helpers.js";
import { prepareModelBudget, type PreparedModelBudget } from "./model-accounting.js";
import type { DeadlineForecast } from "./convergence-policy.js";
import type { RuntimeSession } from "./types.js";

const FINAL_RESPONSE_OUTPUT_TOKENS = 256;

export interface PreparedModelTurn {
  messages: ContextPlan["messages"];
  tools: ModelToolDefinition[];
  toolChoice?: ModelRequest["toolChoice"];
  budget: PreparedModelBudget;
  outputReserveTokens: number;
}

export interface TurnPreparationInput {
  session: RuntimeSession;
  forecast: DeadlineForecast;
  turnId: number;
  descriptors: readonly ToolDescriptor[];
  capabilities: ModelToolProjectionCapabilities;
  dynamic: readonly ContextItem[];
  hookContext: readonly ContextItem[];
  ledger: ContextItem;
  available: BudgetAmounts;
  defaultOutputReserveTokens: number;
  history?: readonly ModelMessage[];
  archive?: ContextItem;
}

export function availableModelBudget(session: RuntimeSession): BudgetAmounts {
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

function firstAttemptBudget(prepared: PreparedModelBudget): Partial<BudgetAmounts> {
  const attempt = prepared.attemptReservations?.[0];
  return attempt ? {
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costMicroUsd: attempt.costMicroUsd ?? 0,
    modelTurns: 1
  } : prepared.reserved;
}

export function requestCapacity(available: BudgetAmounts, prepared: PreparedModelBudget): number {
  const unit = firstAttemptBudget(prepared);
  const dimensions = ["inputTokens", "outputTokens", "costMicroUsd", "modelTurns"] as const;
  return Math.min(3, ...dimensions.map((dimension) => {
    const required = unit[dimension] ?? 0;
    return required <= 0 ? Number.POSITIVE_INFINITY : Math.floor(available[dimension] / required);
  }));
}

export function fitPreparedBudget(
  prepared: PreparedModelBudget,
  available: BudgetAmounts,
  maxAttempts: number
): PreparedModelBudget | null {
  const attempts = prepared.attemptReservations;
  if (!attempts || attempts.length === 0) {
    const fits = (["inputTokens", "outputTokens", "costMicroUsd", "modelTurns"] as const)
      .every((dimension) => (prepared.reserved[dimension] ?? 0) <= available[dimension]);
    return fits ? prepared : null;
  }
  const selected = [];
  const totals = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0 };
  for (const attempt of attempts.slice(0, maxAttempts)) {
    const next = {
      inputTokens: totals.inputTokens + attempt.inputTokens,
      outputTokens: totals.outputTokens + attempt.outputTokens,
      costMicroUsd: totals.costMicroUsd + (attempt.costMicroUsd ?? 0),
      modelTurns: totals.modelTurns + 1
    };
    if (next.inputTokens > available.inputTokens
      || next.outputTokens > available.outputTokens
      || next.costMicroUsd > available.costMicroUsd
      || next.modelTurns > available.modelTurns) break;
    selected.push(attempt);
    Object.assign(totals, next);
  }
  if (selected.length === 0) return null;
  return {
    ...prepared,
    estimatedInputTokens: totals.inputTokens,
    reserved: totals,
    reservedAttempts: selected.length,
    attemptReservations: selected,
    routeConstraints: { ...prepared.routeConstraints, maxAttempts: selected.length }
  };
}

export function budgetFailure(message: string): RunOutcome {
  return { kind: "recoverable_failure", code: "budget_exhausted", message };
}

function budgetContext(input: TurnPreparationInput): ContextItem {
  const remainingMs = Math.max(0,
    Date.parse(input.session.durable.state.deadlineAt) - Date.now());
  const content = [
    "Hard resources remaining (runtime ledger; choose the next action yourself):",
    `timeMs=${remainingMs}`,
    `modelTurns=${input.available.modelTurns}`,
    `toolCalls=${input.available.toolCalls}`,
    `inputTokens=${input.available.inputTokens}`,
    `outputTokens=${input.available.outputTokens}`,
    `costMicroUsd=${input.available.costMicroUsd}`,
    `children=${input.available.children}`
  ].join("\n");
  return {
    id: `runtime:remaining-resources:${input.session.durable.runId}:${input.turnId}`,
    authority: "runtime",
    provenance: "hard resource ledger",
    content,
    tokenCount: Math.max(24, Math.ceil(content.length / 3)),
    priority: 10_000
  };
}

function requestOutputTokens(input: TurnPreparationInput): number {
  const affordable = Math.max(1, Math.floor(
    input.available.outputTokens / APPROXIMATE_TOKEN_RESERVATION_MARGIN
  ));
  if (input.available.modelTurns <= 1) {
    return Math.min(input.defaultOutputReserveTokens, affordable);
  }
  const withFinalReplyHeldBack = Math.max(1, affordable - FINAL_RESPONSE_OUTPUT_TOKENS);
  return Math.min(input.defaultOutputReserveTokens, withFinalReplyHeldBack);
}

export async function prepareBudgetedModelTurn(
  input: TurnPreparationInput
): Promise<{ turn: PreparedModelTurn; plan: ContextPlan }> {
  const {
    session, descriptors, capabilities, dynamic, hookContext, ledger, available
  } = input;
  const tools = modelTools(projectModelToolDescriptors(descriptors, capabilities));
  const outputReserveTokens = requestOutputTokens(input);
  const plan = await providerSizedPlan(session.services.gateway, {
    system: session.interaction.contextItems,
    history: [...(input.history ?? session.durable.state.messages)],
    dynamic: [...dynamic, ...hookContext, ledger, budgetContext(input)],
    tools,
    outputReserveTokens,
    ...(input.archive ? { archive: input.archive } : {})
  });
  const budget = await prepareModelBudget(
    session.services.gateway,
    plan.messages,
    tools,
    outputReserveTokens,
    available.costMicroUsd
  );
  return {
    plan,
    turn: {
      messages: plan.messages,
      tools,
      budget,
      outputReserveTokens
    }
  };
}
