import {
  type BudgetAmounts,
  type ContextItem,
  type JsonValue,
  type ModelRequest,
  type ModelToolDefinition,
  type RunOutcome,
  type ToolDescriptor
} from "agent-protocol";
import { type ContextPlan } from "agent-context";
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

interface ActionPolicy {
  required: boolean;
  outputReserveTokens: number;
  context: ContextItem[];
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : null;
}

function exactProjectedArguments(descriptor: ToolDescriptor): Record<string, JsonValue> | null {
  const properties = jsonObject(descriptor.inputSchema.properties);
  const required = Array.isArray(descriptor.inputSchema.required)
    ? descriptor.inputSchema.required.filter((item): item is string => typeof item === "string") : [];
  if (!properties || required.length === 0) return null;
  const entries: Array<[string, JsonValue]> = [];
  for (const name of required) {
    const property = jsonObject(properties[name]);
    if (!property || property.const === undefined) return null;
    entries.push([name, property.const]);
  }
  return Object.fromEntries(entries);
}

function repositoryConflictActionContext(session: RuntimeSession, names: readonly string[]): string | null {
  const obligation = session.durable.state.taskControl.obligation;
  if (obligation?.kind !== "repository_recovery" || obligation.stage !== "transact"
    || !obligation.transactionId || !obligation.scopePaths?.length) return null;
  return "Task control permits exactly one tool call. A broker-journaled merge conflict is active. "
    + `You may read other workspace files for context, but may modify only these conflict paths: ${JSON.stringify(obligation.scopePaths)}. `
    + "The merge already applied non-conflicting changes; do not rewrite other files during conflict resolution. "
    + `After resolving conflict markers, call git_transaction continue with transactionHandle ${JSON.stringify(obligation.transactionId)} and add only listed conflict paths; abort only if safe resolution is impossible. `
    + `Available action names: ${names.join(", ")}.`;
}

function noProgressActionGuidance(
  session: RuntimeSession,
  descriptors: readonly ToolDescriptor[]
): string {
  const count = session.durable.state.taskControl.episode.noProgressBatches;
  if (count <= 0) return "";
  const completionActions = descriptors
    .filter((descriptor) => descriptor.possibleEffects.includes("outcome.propose"))
    .map((descriptor) => descriptor.name);
  const completion = completionActions.length > 0
    ? ` If the user's task is already complete and the current mutation frontier has successful semantic validation, use a completion action now (${completionActions.join(", ")}).`
    : "";
  return ` The last ${count} completed tool ${count === 1 ? "batch produced" : "batches produced"} no new trusted task facts. Do not repeat a read or command whose result is already known. Otherwise, choose one action that changes the current workspace frontier or semantically validates it.${completion}`;
}

function toolArgumentRepairContext(session: RuntimeSession, names: readonly string[]): string | null {
  const control = session.durable.state.taskControl;
  if (control.obligation || control.episode.noProgressBatches >= 2
    || control.policyCorrection?.failureCode !== "tool_arguments_invalid") return null;
  return "The previous tool arguments were rejected. Retry each intended call with a direct JSON object "
    + "that matches the displayed schema; do not JSON-encode the arguments object. "
    + `Independent corrected calls may be submitted together. Available action names: ${names.join(", ")}.`;
}

function taskControlActionContext(
  input: TurnPreparationInput,
  descriptors: readonly ToolDescriptor[]
): ContextItem[] {
  if (!input.repairPending || descriptors.length === 0) return [];
  const names = descriptors.map((descriptor) => descriptor.name);
  const exact = descriptors.length === 1 ? exactProjectedArguments(descriptors[0]!) : null;
  const argumentRepair = toolArgumentRepairContext(input.session, names);
  const conflict = repositoryConflictActionContext(input.session, names);
  const content = argumentRepair ?? conflict ?? (exact
    ? `Task control permits exactly one tool call. Call ${names[0]} with exactly these arguments: ${JSON.stringify(exact)}. Do not invent an alias or omit a field.`
    : `Task control permits exactly one tool call. Available action names: ${names.join(", ")}. Use one displayed name and follow its schema exactly; do not invent an alias.${noProgressActionGuidance(input.session, descriptors)}`);
  return [{
    id: `runtime:task-control-action:${input.session.durable.runId}:${input.turnId}`,
    authority: "runtime",
    provenance: "task-control projection",
    content,
    tokenCount: Math.max(32, Math.ceil(content.length / 3)),
    priority: 20_000
  }];
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
  budgetStage: BudgetStage;
  defaultOutputReserveTokens: number;
}

function actionPolicy(
  input: TurnPreparationInput,
  descriptors: readonly ToolDescriptor[]
): ActionPolicy {
  const { session, forecast, turnId, defaultOutputReserveTokens, budgetStage } = input;
  const lengthRecovery = session.durable.state.taskControl.modelContinuationAttempts > 0;
  const required = lengthRecovery || forecast.stage === "converge" || budgetStage !== "normal";
  const outputReserveTokens = required ? Math.min(2_048, defaultOutputReserveTokens) : defaultOutputReserveTokens;
  const projectedAction = taskControlActionContext(input, descriptors);
  if (!required) return { required, outputReserveTokens, context: projectedAction };
  const content = lengthRecovery
    ? "The previous response reached its output limit, and its private reasoning is not replayed. Do not reconstruct or continue that reasoning. Choose one concrete tool action now, based on the durable conversation and evidence."
    : budgetStage === "terminal"
      ? "Budget stage is terminal. Use one available terminal tool now. Do not start or describe additional work."
      : forecast.stage === "converge"
        ? "Deadline stage is converge. Resolve the active prerequisite with one focused tool action now. Do not start exploratory work."
        : budgetStage === "converge"
          ? "Budget stage is converge. Choose one focused action now and preserve the next model turn for a terminal outcome. Do not start exploratory work."
          : "Convergence requires one focused tool action now, followed immediately by the appropriate terminal tool.";
  return { required, outputReserveTokens, context: [...projectedAction, {
    id: `runtime:action-required:${session.durable.runId}:${turnId}`,
    authority: "runtime",
    provenance: lengthRecovery ? "length recovery" : "deadline stage",
    content,
    tokenCount: lengthRecovery ? 42 : 30,
    priority: 10_000
  }] };
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

export function deadlineBudgetStage(
  forecast: DeadlineForecast,
  descriptors: readonly ToolDescriptor[]
): BudgetStage {
  if (forecast.stage !== "converge") return "normal";
  // A deadline convergence turn must be enforceable, not merely advisory.
  // Project terminal actions immediately when one is available; otherwise
  // preserve one focused prerequisite/repair action so task control can make
  // a terminal action available on the following turn.
  return descriptors.some(terminalDescriptor) ? "terminal" : "converge";
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
    available, repairPending, budgetStage
  } = input;
  const stageDescriptors = budgetStage === "terminal" ? descriptors.filter(terminalDescriptor) : descriptors;
  if (budgetStage === "terminal" && stageDescriptors.length === 0) {
    throw Object.assign(new Error("No terminal tool is available for the final budgeted turn."), {
      code: "budget_exhausted"
    });
  }
  const tools = modelTools(projectModelToolDescriptors(stageDescriptors, capabilities));
  const policy = actionPolicy(input, stageDescriptors);
  const outputReserveTokens = budgetStage === "normal" ? policy.outputReserveTokens : Math.max(1, Math.min(
    policy.outputReserveTokens,
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
      history: session.durable.state.messages,
      dynamic: [...dynamic, ...hookContext, ledger, ...policy.context],
      tools,
      outputReserveTokens,
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
      ...(tools.length > 0 && (repairPending || policy.required) ? { toolChoice: "required" as const } : {}),
      budget,
      outputReserveTokens
    }
  };
}
