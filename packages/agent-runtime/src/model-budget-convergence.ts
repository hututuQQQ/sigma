import {
  type BudgetAmounts,
  type ContextItem,
  type ModelCapabilities,
  type ModelMessage,
  type ModelRequest,
  type ModelToolDefinition,
  type RunOutcome,
  type ToolDescriptor
} from "agent-protocol";
import { type ContextPlan, type PlanContextOptions } from "agent-context";
import { lengthConvergenceRequired, stickyLengthDebt } from "agent-kernel";
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

export interface PreparedModelTurn {
  messages: ContextPlan["messages"];
  tools: ModelToolDefinition[];
  toolChoice?: ModelRequest["toolChoice"];
  budget: PreparedModelBudget;
  outputReserveTokens: number;
}

export type BudgetStage = "normal" | "converge" | "terminal";

export const REASONING_OUTPUT_RESERVE_TOKENS = 32_768;
export const FIRST_LENGTH_CONTINUATION_TOKENS = 16_384;
export const CONVERGENCE_OUTPUT_RESERVE_TOKENS = 4_096;

export function defaultModelOutputReserveTokens(capabilities: ModelCapabilities): number {
  const preferred = capabilities.reasoning ? REASONING_OUTPUT_RESERVE_TOKENS : 8_192;
  return Math.min(preferred, capabilities.maxOutputTokens);
}

interface ActionPolicy {
  required: boolean;
  outputReserveTokens: number;
  context: ContextItem[];
}

function runtimeCompletionCall(message: ModelMessage): string[] {
  return (message.toolCalls ?? []).filter((call) => call.name === "runtime_finalize"
    || call.id.startsWith("runtime_completion_intent_")).map((call) => call.id);
}

/** Durable synthetic completion remains auditable but is never provider input. */
export function providerVisibleHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const internalCallIds = new Set(messages.flatMap(runtimeCompletionCall));
  return messages.flatMap((message) => {
    if (message.role === "tool" && message.toolCallId && internalCallIds.has(message.toolCallId)) return [];
    if (message.role !== "assistant" || !message.toolCalls?.some((call) => internalCallIds.has(call.id))) {
      return [{ ...message }];
    }
    const toolCalls = message.toolCalls.filter((call) => !internalCallIds.has(call.id));
    return [{
      ...message,
      ...(toolCalls.length > 0 ? { toolCalls } : { toolCalls: undefined })
    }];
  });
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
  repairPending: boolean;
  allowNaturalCompletion: boolean;
  budgetStage: BudgetStage;
  defaultOutputReserveTokens: number;
}

function adaptiveOutputReserve(
  preferred: number,
  firstLengthContinuation: boolean,
  required: boolean
): number {
  if (required) return Math.min(CONVERGENCE_OUTPUT_RESERVE_TOKENS, preferred);
  if (firstLengthContinuation) return Math.min(FIRST_LENGTH_CONTINUATION_TOKENS, preferred);
  return preferred;
}

function requiredActionContent(
  repeatedLength: boolean,
  forecast: DeadlineForecast,
  budgetStage: BudgetStage
): string {
  if (repeatedLength) {
    return "The model reached its output limit in consecutive turns. Its private reasoning is not replayed. Choose one concrete tool action now from durable state; do not restart or narrate the analysis.";
  }
  if (budgetStage === "terminal") {
    return "Budget stage is terminal. Use one available terminal tool now. Do not start or describe additional work.";
  }
  if (forecast.actionDebt >= 2) {
    return "Repeated semantically similar tool actions have not changed the workspace, validation frontier, plan obligations, or process state. Use one focused tool action now to produce or validate the best available deliverable, then immediately choose the appropriate terminal outcome. Do not continue exploratory variants.";
  }
  if (forecast.stage === "converge") {
    return "Deadline stage is converge. Choose one focused tool action now, then immediately use the appropriate terminal tool. Do not start exploratory work.";
  }
  if (budgetStage === "converge") {
    return "Budget stage is converge. Choose one focused action now and preserve the next model turn for a terminal outcome. Do not start exploratory work.";
  }
  return "Convergence requires one focused tool action now, followed immediately by the appropriate terminal tool.";
}

function specialActionPolicy(
  input: TurnPreparationInput,
  outputReserveTokens: number,
  firstLengthContinuation: boolean
): ActionPolicy | null {
  const { session, turnId, budgetStage, allowNaturalCompletion } = input;
  if (budgetStage === "terminal" && !input.descriptors.some(terminalDescriptor)) return {
    required: false,
    outputReserveTokens,
    context: [{
      id: `runtime:natural-terminal:${session.durable.runId}:${turnId}`,
      authority: "runtime",
      provenance: "terminal fallback",
      content: "No terminal tool is available in this runtime. Answer directly now; the runtime will apply the same assurance and completion gates to the natural stop. Do not start or describe additional work.",
      tokenCount: 32,
      priority: 10_000
    }]
  };
  if (session.durable.state.completionRepair?.kind === "no_change_confirmation") return {
    required: true,
    outputReserveTokens: Math.min(2_048, input.defaultOutputReserveTokens),
    context: [{
      id: `runtime:no-change-confirmation:${session.durable.runId}:${turnId}`,
      authority: "runtime",
      provenance: "terminal intent confirmation",
      content: "The protected original answer ended a change task with no net workspace mutation. Choose exactly one offered terminal intent: confirm_no_change if the request is already satisfied, request_user_input if a concrete user decision is required, or report_blocked for a durable blocker. Do not repeat the answer as ordinary text.",
      tokenCount: 55,
      priority: 10_000
    }]
  };
  if (allowNaturalCompletion) return {
    required: false,
    outputReserveTokens,
    context: [{
      id: `runtime:completion-ready:${session.durable.runId}:${turnId}`,
      authority: "runtime",
      provenance: "completion prerequisite",
      content: "The pending completion prerequisite has new durable evidence. If the task is now complete, answer normally; the runtime owns finalization. Use a blocker or input request only when it is genuinely required.",
      tokenCount: 32,
      priority: 10_000
    }]
  };
  if (firstLengthContinuation) return {
    required: false,
    outputReserveTokens,
    context: [{
      id: `runtime:length-continuation:${session.durable.runId}:${turnId}`,
      authority: "runtime",
      provenance: "length continuation",
      content: "The previous response reached its output limit, and its private reasoning is not replayed. Continue from the durable conversation and evidence without reconstructing that reasoning. Use a concrete tool action when more work is needed, or answer directly when the task is complete.",
      tokenCount: 45,
      priority: 10_000
    }]
  };
  return null;
}

function actionPolicy(input: TurnPreparationInput): ActionPolicy {
  const {
    session, forecast, turnId, defaultOutputReserveTokens, budgetStage
  } = input;
  const lengthDebt = stickyLengthDebt(session.durable.state);
  const repeatedLength = lengthConvergenceRequired(session.durable.state);
  const firstLengthContinuation = lengthDebt === 1;
  const convergence = forecast.stage === "converge" || budgetStage !== "normal";
  const required = repeatedLength || convergence;
  const outputReserveTokens = adaptiveOutputReserve(
    defaultOutputReserveTokens,
    firstLengthContinuation,
    required
  );
  const special = specialActionPolicy(input, outputReserveTokens, firstLengthContinuation && !required);
  if (special) return special;
  if (!required) return { required, outputReserveTokens, context: [] };
  const content = requiredActionContent(repeatedLength, forecast, budgetStage);
  const actionDebt = !repeatedLength && budgetStage !== "terminal" && forecast.actionDebt >= 2;
  return { required, outputReserveTokens, context: [{
    id: `runtime:action-required:${session.durable.runId}:${turnId}`,
    authority: "runtime",
    provenance: repeatedLength ? "repeated length recovery" : actionDebt ? "action debt" : "deadline stage",
    content,
    tokenCount: repeatedLength ? 37 : actionDebt ? 48 : 30,
    priority: 10_000
  }] };
}

type HistoryPlanPolicy = Pick<PlanContextOptions,
  "historyTokenLimit" | "rawHistoryBlockTokenLimit"
  | "historySummaryTokenLimit" | "maximumRawHistoryBlocks">;

function historyPlanPolicy(session: RuntimeSession, stage: BudgetStage): Partial<HistoryPlanPolicy> {
  if (stage === "terminal") return {
    historyTokenLimit: 12_000, rawHistoryBlockTokenLimit: 8_192,
    historySummaryTokenLimit: 4_000, maximumRawHistoryBlocks: 4
  };
  if (stage === "converge") return {
    historyTokenLimit: 24_000, rawHistoryBlockTokenLimit: 8_192,
    historySummaryTokenLimit: 8_000, maximumRawHistoryBlocks: 6
  };
  if (stickyLengthDebt(session.durable.state) === 1) return {
    historyTokenLimit: 48_000, rawHistoryBlockTokenLimit: 8_192,
    historySummaryTokenLimit: 8_000, maximumRawHistoryBlocks: 8
  };
  return {};
}

export function availableModelBudget(session: RuntimeSession): BudgetAmounts {
  const ledger = session.durable.state.budget;
  return {
    inputTokens: Math.max(0, ledger.limits.inputTokens - ledger.consumed.inputTokens - ledger.reserved.inputTokens),
    outputTokens: Math.max(0, ledger.limits.outputTokens - ledger.consumed.outputTokens - ledger.reserved.outputTokens),
    costMicroUsd: Math.max(0, ledger.limits.costMicroUsd - ledger.consumed.costMicroUsd - ledger.reserved.costMicroUsd),
    modelTurns: Math.max(0, ledger.limits.modelTurns - ledger.consumed.modelTurns - ledger.reserved.modelTurns),
    toolCalls: Math.max(0, ledger.limits.toolCalls - ledger.consumed.toolCalls - ledger.reserved.toolCalls),
    children: Math.max(0, ledger.limits.children - ledger.consumed.children - ledger.reserved.children)
  };
}

function terminalDescriptor(descriptor: ToolDescriptor): boolean {
  return descriptor.possibleEffects.some((effect) => effect === "outcome.propose"
    || effect === "outcome.report_blocked" || effect === "outcome.request_input");
}

function requiresToolChoice(
  tools: readonly ModelToolDefinition[],
  repairPending: boolean,
  policyRequired: boolean,
  allowNaturalCompletion: boolean
): boolean {
  return tools.length > 0 && !allowNaturalCompletion && (repairPending || policyRequired);
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
    if (next.inputTokens > available.inputTokens || next.outputTokens > available.outputTokens
      || next.costMicroUsd > available.costMicroUsd || next.modelTurns > available.modelTurns) break;
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

export async function prepareBudgetedModelTurn(
  input: TurnPreparationInput
): Promise<{ turn: PreparedModelTurn; plan: ContextPlan }> {
  const {
    session, descriptors, capabilities, dynamic, hookContext, ledger,
    available, repairPending, allowNaturalCompletion, budgetStage
  } = input;
  const stageDescriptors = budgetStage === "terminal" ? descriptors.filter(terminalDescriptor) : descriptors;
  const tools = modelTools(projectModelToolDescriptors(stageDescriptors, capabilities));
  // A runtime can legitimately expose no terminal model tool (for example an
  // analysis-only embedding). Natural stop is still safe because the runtime
  // synthesizes completion intent and applies the identical assurance gate.
  // Do not mask an upstream model/protocol failure as budget exhaustion merely
  // because deadline projection entered the terminal stage first.
  const policy = actionPolicy({ ...input, descriptors: stageDescriptors });
  const outputReserveTokens = Math.max(1, Math.min(
    policy.outputReserveTokens,
    session.services.gateway.capabilities.maxOutputTokens,
    Math.floor(available.outputTokens / APPROXIMATE_TOKEN_RESERVATION_MARGIN)
  ));
  const turnsToReserve = budgetStage === "converge" ? 2 : 1;
  const maxInputTokens = budgetStage === "normal" ? undefined : Math.max(1, Math.floor(
    available.inputTokens / turnsToReserve / APPROXIMATE_TOKEN_RESERVATION_MARGIN
  ));
  let plan: ContextPlan;
  try {
    plan = await providerSizedPlan(session.services.gateway, {
      system: session.interaction.contextItems,
      history: providerVisibleHistory(session.durable.state.messages),
      dynamic: [...dynamic, ...hookContext, ledger, ...policy.context],
      tools,
      outputReserveTokens,
      ...historyPlanPolicy(session, budgetStage),
      ...(maxInputTokens ? { maxInputTokens } : {})
    });
  } catch (error) {
    if (budgetStage === "normal" || (error as { code?: unknown })?.code !== "context_overflow") throw error;
    throw Object.assign(new Error(
      "The remaining input budget cannot fit mandatory context and terminal tools after compaction."
    ), { code: "budget_exhausted" });
  }
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
      ...(requiresToolChoice(tools, repairPending, policy.required, allowNaturalCompletion)
        ? { toolChoice: "required" as const } : {}),
      budget,
      outputReserveTokens
    }
  };
}
