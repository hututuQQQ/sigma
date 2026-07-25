import { createHash } from "node:crypto";
import type {
  BudgetAmounts,
  ContextItem,
  JsonValue,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
  RunOutcome,
  RuntimePromptStateV2,
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
import type { RuntimeSession } from "./types.js";
import { planLedger } from "./model-plan-ledger.js";
import { longHorizonLedger } from "./long-horizon-ledger.js";
import {
  materializeRuntimePromptFrame,
  type RuntimePromptFrame
} from "./runtime-prompt-state.js";
import { availableOrchestratorBudget } from "./assurance-budget.js";
import {
  repairEpisodeNotice,
  repairEpisodeWindow
} from "./repair-episode-policy.js";

const FINAL_RESPONSE_OUTPUT_TOKENS = 256;

export interface PreparedModelTurn {
  messages: ContextPlan["messages"];
  tools: ModelToolDefinition[];
  toolChoice?: ModelRequest["toolChoice"];
  budget: PreparedModelBudget;
  outputReserveTokens: number;
  toolSchemaDigest: string;
  requestDigest: string;
  promptState: RuntimePromptStateV2;
  frameMode: "full" | "delta";
}

export interface TurnPreparationInput {
  session: RuntimeSession;
  /** Kept optional for one compatibility release; deadlines are not model-visible. */
  forecast?: unknown;
  turnId: number;
  descriptors: readonly ToolDescriptor[];
  capabilities: ModelToolProjectionCapabilities;
  dynamic: readonly ContextItem[];
  hookContext: readonly ContextItem[];
  ledger: ContextItem;
  planLedger?: ContextItem;
  turnOnly?: readonly ContextItem[];
  available: BudgetAmounts;
  defaultOutputReserveTokens: number;
  history?: readonly ModelMessage[];
  archive?: ContextItem;
}

export function availableModelBudget(session: RuntimeSession): BudgetAmounts {
  return availableOrchestratorBudget(session);
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

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function requestOutputTokens(input: TurnPreparationInput): number {
  const recovery = input.session.durable.state.lengthRecovery.mode;
  const repairClosure = repairEpisodeWindow(input.session).closureRequired;
  const strictRecoveryUnavailable = recovery === "bounded_answer"
    || (recovery === "action_required"
      && (!input.session.services.gateway.capabilities.strictToolChoice
      || !input.session.services.gateway.capabilities.tools
      || input.descriptors.length === 0));
  const desired = repairClosure
    ? 2_048
    : strictRecoveryUnavailable
    ? 2_048
    : recovery === "continue_after_tools"
      ? Math.max(input.defaultOutputReserveTokens, 16_384)
      : input.defaultOutputReserveTokens;
  const providerCapped = Math.min(
    desired,
    input.session.services.gateway.capabilities.maxOutputTokens
  );
  const affordable = Math.max(1, Math.floor(
    input.available.outputTokens / APPROXIMATE_TOKEN_RESERVATION_MARGIN
  ));
  if (input.available.modelTurns <= 1) {
    return Math.min(providerCapped, affordable);
  }
  const withFinalReplyHeldBack = Math.max(1, affordable - FINAL_RESPONSE_OUTPUT_TOKENS);
  return Math.min(providerCapped, withFinalReplyHeldBack);
}

function recoveryNotice(input: TurnPreparationInput): ContextItem | undefined {
  const mode = input.session.durable.state.lengthRecovery.mode;
  if (mode === "none") return undefined;
  const strictAvailable = input.session.services.gateway.capabilities.strictToolChoice === true
    && input.session.services.gateway.capabilities.tools
    && input.descriptors.length > 0;
  const content = mode === "continue_after_tools"
    ? "The previous length-limited turn issued tool calls. Their side effects were executed exactly once. Continue from the receipts without repeating those calls."
    : mode === "action_required" && strictAvailable
      ? "The previous turn exhausted its output limit without acting. Stop expanding the reasoning and take one concrete tool action now."
      : "The previous turn exhausted its output limit without acting, and this provider cannot force a tool safely. Give the smallest complete user-facing answer within this one bounded recovery turn.";
  return {
    id: `runtime:length-recovery:${mode}:${strictAvailable ? "strict" : "fallback"}`,
    authority: "runtime",
    provenance: "length_recovery",
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    priority: 10_100
  };
}

function committedPromptState(
  input: TurnPreparationInput,
  frame: RuntimePromptFrame,
  plan: ContextPlan
): RuntimePromptStateV2 {
  const included = new Set(plan.included.map((item) => item.id));
  const previous = input.session.durable.state.promptState;
  const sectionDigests = { ...previous.sectionDigests };
  for (const section of ["repository", "completion", "plan", "longHorizon", "budget"] as const) {
    const item = frame.items.find((candidate) => candidate.id.startsWith(`runtime:state:${section}:`));
    if (item && included.has(item.id)) {
      const digest = frame.promptState.sectionDigests[section];
      if (digest) sectionDigests[section] = digest;
    }
  }
  return {
    ...frame.promptState,
    sectionDigests
  };
}

function recoveryRequestPolicy(
  session: RuntimeSession,
  projectedTools: ModelToolDefinition[]
): { tools: ModelToolDefinition[]; toolChoice?: ModelRequest["toolChoice"] } {
  if (repairEpisodeWindow(session).closureRequired) {
    return { tools: [], toolChoice: "none" };
  }
  const mode = session.durable.state.lengthRecovery.mode;
  if (mode === "continue_after_tools") {
    return { tools: projectedTools, toolChoice: "auto" };
  }
  if (mode !== "action_required" && mode !== "bounded_answer") {
    return { tools: projectedTools };
  }
  if (mode === "bounded_answer") {
    return { tools: [], toolChoice: "none" };
  }
  const strictAvailable = session.services.gateway.capabilities.strictToolChoice === true
    && projectedTools.length > 0;
  return strictAvailable
    ? { tools: projectedTools, toolChoice: "required" }
    : { tools: [], toolChoice: "none" };
}

export async function prepareBudgetedModelTurn(
  input: TurnPreparationInput
): Promise<{ turn: PreparedModelTurn; plan: ContextPlan }> {
  const { session, descriptors, capabilities, dynamic, hookContext, ledger, available } = input;
  const projectedTools = modelTools(projectModelToolDescriptors(descriptors, capabilities));
  const { tools, toolChoice } = recoveryRequestPolicy(session, projectedTools);
  const outputReserveTokens = requestOutputTokens(input);
  const recovery = recoveryNotice(input);
  const repair = repairEpisodeNotice(session);
  const frame = materializeRuntimePromptFrame(session, available, {
    repository: dynamic,
    completion: ledger,
    plan: input.planLedger ?? planLedger(session),
    longHorizon: longHorizonLedger(session),
    turnOnly: [
      ...hookContext,
      ...(input.turnOnly ?? []),
      ...(recovery ? [recovery] : []),
      ...(repair ? [repair] : [])
    ]
  });
  const plan = await providerSizedPlan(session.services.gateway, {
    system: session.interaction.contextItems,
    history: [...(input.history ?? session.durable.state.messages)],
    dynamic: frame.items,
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
  const toolSchemaDigest = sha256(tools as unknown as JsonValue);
  const requestDigest = sha256({
    messages: plan.messages,
    tools,
    outputReserveTokens,
    toolChoice: toolChoice ?? null
  } as unknown as JsonValue);
  return {
    plan,
    turn: {
      messages: plan.messages,
      tools,
      budget,
      outputReserveTokens,
      toolSchemaDigest,
      requestDigest,
      ...(toolChoice ? { toolChoice } : {}),
      promptState: committedPromptState(input, frame, plan),
      frameMode: frame.frameMode
    }
  };
}
