import {
  type BudgetAmounts,
  type ContextItem,
  type ModelExecutionRole,
  type ModelMessage,
   type ModelRequest,
   type ModelResponse,
   type ModelToolDefinition
} from "agent-protocol";
import type { KernelEffect } from "agent-kernel";
import { RepositoryContextProvider, type ContextPlan } from "agent-context";
import { isToolAllowed } from "agent-tools";
import {
  modelTools,
  projectModelToolDescriptors,
  providerSizedPlan,
  sessionSkillProjectionCapabilities,
  steeringRestart
} from "./effect-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";
import {
  consumedBudget,
  failedModelUsage,
  prepareModelBudget,
  successfulModelUsage,
  type PreparedModelBudget
} from "./model-accounting.js";
import { evidenceLedger } from "./model-evidence-ledger.js";
import { profileAllowsTool } from "./profile-policy.js";
import { completionRepairPhase, descriptorsAllowedForRepair } from "./tool-turn-policy.js";
import {
  modelFailureCode,
  modelFailureDiagnostics,
  modelFailureMessage,
  streamModelResponse
} from "./model-effect-support.js";
import { deadlineForecast, type DeadlineForecast } from "./convergence-policy.js";

type RequestModelEffect = Extract<KernelEffect, { type: "request_model" }>;

interface PreparedModelTurn {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  toolChoice?: ModelRequest["toolChoice"];
  budget: PreparedModelBudget;
  outputReserveTokens: number;
}

interface ModelReservationState {
  settled: boolean;
  response?: ModelResponse; consumed?: Partial<BudgetAmounts>;
}

function modelVisibleOutputTruncatedBytes(session: RuntimeSession): number {
  return session.durable.state.receipts
    .flatMap((receipt) => receipt.diagnostics)
    .reduce((total, diagnostic) => {
      const match = /^model_output_truncated:(?:stdout|stderr):(\d+)$/u.exec(diagnostic);
      return total + (match ? Number(match[1]) : 0);
    }, 0);
}

interface ActionPolicy {
  required: boolean;
  outputReserveTokens: number;
  context: ContextItem[];
}

function actionPolicy(
  session: RuntimeSession,
  forecast: DeadlineForecast,
  turnId: number,
  defaultOutputReserveTokens: number
): ActionPolicy {
  const lengthRecovery = session.durable.state.continuationAttempts > 0;
  const required = lengthRecovery || forecast.stage === "converge";
  const outputReserveTokens = required ? Math.min(2_048, defaultOutputReserveTokens) : defaultOutputReserveTokens;
  if (!required) return { required, outputReserveTokens, context: [] };
  const content = lengthRecovery
    ? "The previous response reached its output limit, and its private reasoning is not replayed. Do not reconstruct or continue that reasoning. Choose one concrete tool action now, based on the durable conversation and evidence."
    : "Deadline stage is converge. Choose one focused tool action now, then immediately use the appropriate terminal tool. Do not start exploratory work.";
  return { required, outputReserveTokens, context: [{
    id: `runtime:action-required:${session.durable.runId}:${turnId}`,
    authority: "runtime",
    provenance: lengthRecovery ? "length recovery" : "deadline stage",
    content,
    tokenCount: lengthRecovery ? 42 : 30,
    priority: 10_000
  }] };
}

export class ModelEffectRunner {
  private readonly repositoryContext: RepositoryContextProvider;

  constructor(private readonly options: EffectRunnerOptions) {
    // Pre-model context is trusted, read-only runtime work. Keeping it on the
    // host filesystem prevents an indexing probe from consuming or closing the
    // shared sandbox broker used by model-requested tools and background work.
    this.repositoryContext = new RepositoryContextProvider();
  }

  async request(session: RuntimeSession, signal: AbortSignal, effect: RequestModelEffect): Promise<void> {
    const turnController = new AbortController();
    session.execution.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    const turnId = ++session.durable.modelTurn;
    let effectRevision = effect.revision;
    try {
      const hookResult = await this.options.hooks.dispatch(session, "pre_model", {
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        mode: session.durable.mode,
        turnId,
        effectRevision: effect.revision,
        provider: session.services.gateway.provider,
        model: session.services.gateway.model,
        messageCount: session.durable.state.messages.length
      }, turnSignal);
      effectRevision = session.durable.state.revision;
      await this.options.emit(session, "model.started", "runtime", {
        provider: session.services.gateway.provider,
        model: session.services.gateway.model,
        turnId,
        effectRevision
      });
      if (!this.isCurrent(session, turnId, effectRevision)) return;
      await this.attempt(session, turnId, effectRevision, turnSignal, hookResult.contextItems);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "hook_gate_denied") throw error;
      await this.handleFailure(session, turnId, effectRevision, turnSignal, error);
    }
  }

  private isCurrent(session: RuntimeSession, turnId: number, effectRevision: number): boolean {
    return session.durable.state.activeModelTurn?.turnId === turnId
      && session.durable.state.activeModelTurn.effectRevision === effectRevision;
  }

  private async handleFailure(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal,
    error: unknown
  ): Promise<void> {
    if (steeringRestart(signal)) {
      await this.options.emit(session, "diagnostic", "runtime", {
        kind: "steering.restart", turnId, effectRevision
      });
      return;
    }
    if (!this.isCurrent(session, turnId, effectRevision)) return;
    const code = modelFailureCode(error);
    const routeFailure = error as {
      routeId?: unknown; modelSpecId?: unknown; attempts?: unknown; category?: unknown; semanticDelta?: unknown
    };
    if (typeof routeFailure.routeId === "string" && typeof routeFailure.modelSpecId === "string") {
      await this.options.emit(session, "model.route_failed", "runtime", {
        role: session.services.modelRole,
        routeId: routeFailure.routeId,
        modelSpecId: routeFailure.modelSpecId,
        attempt: typeof routeFailure.attempts === "number" ? routeFailure.attempts : 1,
        category: typeof routeFailure.category === "string" ? routeFailure.category : "protocol",
        semanticDelta: routeFailure.semanticDelta === true
      });
    }
    await this.options.emit(session, "model.failed", "runtime", {
      turnId,
      effectRevision,
      code,
      message: modelFailureMessage(error),
      diagnostics: modelFailureDiagnostics(
        error,
        session.services.gateway.provider,
        session.services.gateway.model
      )
    });
  }

  private async emitContextComposition(
    session: RuntimeSession,
    plan: ContextPlan,
    forecast: DeadlineForecast
  ): Promise<void> {
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "context.composition",
      ...plan.budget,
      latestHistoryBlockTokens: plan.latestHistoryBlockTokens,
      omittedHistoryTurns: plan.omittedHistoryTurns,
      cacheMode: plan.cacheMode,
      historyTokenLimit: plan.historyTokenLimit,
      dynamicSuffixTokens: plan.dynamicSuffixTokens,
      modelVisibleOutputTruncatedBytes: modelVisibleOutputTruncatedBytes(session),
      reviewCount: session.durable.state.evidence.filter((item) => item.kind === "review").length,
      deadlineStage: forecast.stage,
      executionMode: this.options.runtime.runtimeEnvironment?.executionMode ?? "sandboxed"
    });
  }

  private async attempt(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal,
    hookContext: readonly ContextItem[]
  ): Promise<void> {
    const availableDescriptors = this.options.runtime.tools.descriptors().filter((item) =>
      isToolAllowed(item, session.durable.mode) && profileAllowsTool(session, item));
    const repairPhase = completionRepairPhase(session);
    // Every protocol-repair phase is a tool sub-turn, including recovery after
    // a failed terminal action. Keeping the choice forced prevents a provider
    // from silently switching modes between the repair call and its recovery.
    const repairPending = repairPhase !== "none";
    const ledger = evidenceLedger(session);
    const descriptors = descriptorsAllowedForRepair(availableDescriptors, repairPhase);
    const projectedDescriptors = projectModelToolDescriptors(
      descriptors,
      sessionSkillProjectionCapabilities({
        frozenCustomization: session.durable.frozenCustomization,
        liveSkillDescriptors: this.options.runtime.skills?.descriptors,
        loadedSkills: session.durable.state.frozenSkills,
        profileSkillNames: session.services.profile?.profile.skills
      })
    );
    const tools = modelTools(projectedDescriptors);
    const query = [...session.durable.state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const dynamic = await this.repositoryContext.collect(session.identity.workspacePath, query, signal);
    const forecast = deadlineForecast(session);
    const policy = actionPolicy(session, forecast, turnId, this.options.outputReserveTokens);
    const outputReserveTokens = policy.outputReserveTokens;
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "deadline.stage",
      stage: forecast.stage,
      remainingMs: forecast.remainingMs,
      nextModelEstimateMs: forecast.nextModelEstimateMs,
      outputReserveTokens
    });
    const plan = await providerSizedPlan(session.services.gateway, {
      system: session.interaction.contextItems,
      history: session.durable.state.messages,
      // Keep the stable system prefix cacheable. The evidence ledger is
      // current-run state and belongs in the dynamic suffix, where changes do
      // not invalidate static policy/context cache entries.
      dynamic: [...dynamic, ...hookContext, ledger, ...policy.context],
      tools,
      outputReserveTokens
    });
    await this.emitContextComposition(session, plan, forecast);
    if (plan.summary && !session.interaction.loadedContextIds.has(plan.summary.id)) {
      session.interaction.loadedContextIds.add(plan.summary.id);
      await this.options.emit(session, "context.compacted", "runtime", {
        item: plan.summary,
        omittedHistoryTurns: plan.omittedHistoryTurns
      });
    }
    signal.throwIfAborted();
    const budget = await prepareModelBudget(
      session.services.gateway,
      plan.messages,
      tools,
      outputReserveTokens,
      Math.max(0, session.durable.state.budget.limits.costMicroUsd
        - session.durable.state.budget.consumed.costMicroUsd
        - session.durable.state.budget.reserved.costMicroUsd)
    );
    const turn: PreparedModelTurn = {
      messages: plan.messages,
      tools,
      ...(tools.length > 0 && (repairPending || policy.required) ? { toolChoice: "required" } : {}),
      budget,
      outputReserveTokens
    };
    const requestId = `${session.durable.runId}:${turnId}`;
    const reservationId = await this.options.budgets.reserve(session, `model:${requestId}`, budget.reserved);
    await this.runReserved(session, turnId, effectRevision, signal, turn, requestId, reservationId);
  }

  private async runReserved(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal,
    turn: PreparedModelTurn,
    requestId: string,
    reservationId: string
  ): Promise<void> {
    const startedAt = performance.now();
    const state: ModelReservationState = { settled: false };
    try {
      const response = await streamModelResponse(
        this.options, session, turnId, turn.messages, turn.tools, turn.toolChoice, signal,
        turn.budget.routeConstraints, turn.outputReserveTokens
      );
      state.response = response;
      await this.completeReservation(
        session, turnId, effectRevision, signal, turn, requestId, reservationId, response, startedAt, state
      );
    } catch (error) {
      if (!state.settled && state.response) {
        await (state.consumed
          ? this.options.budgets.commitMeasured(session, reservationId, state.consumed)
          : this.options.budgets.settleInterruptedModel(session, requestId));
        state.settled = true;
      } else if (!state.settled) {
        await this.commitFailure(session, turn, requestId, reservationId, startedAt, error);
      }
      throw error;
    }
  }

  private async completeReservation(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal,
    turn: PreparedModelTurn,
    requestId: string,
    reservationId: string,
    response: ModelResponse,
    startedAt: number,
    state: ModelReservationState
  ): Promise<void> {
    const usage = successfulModelUsage(
      session,
      session.services.gateway,
      requestId,
      { messages: turn.messages, tools: turn.tools },
      response,
      turn.budget,
      performance.now() - startedAt,
      session.services.modelRole
    );
    state.consumed = consumedBudget(usage, turn.budget);
    await this.options.budgets.commitMeasured(session, reservationId, state.consumed);
    state.settled = true;
    await this.emitResolvedRoute(session, response);
    await this.options.emit(session, "usage.recorded", "runtime", usage);
    await this.options.emit(session, "model.completed", "runtime", {
      model: usage.modelId,
      turnId,
      effectRevision,
      text: response.message.content,
      finishReason: response.finishReason,
      message: response.message,
      toolCalls: response.message.toolCalls ?? [],
      usage
    });
    await this.options.hooks.dispatch(session, "post_model", {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      turnId,
      effectRevision,
      provider: usage.providerId,
      model: usage.modelId,
      finishReason: response.finishReason,
      hasContent: response.message.content.length > 0,
      toolCallCount: response.message.toolCalls?.length ?? 0,
      usage
    }, signal);
  }

  private async emitResolvedRoute(session: RuntimeSession, response: ModelResponse): Promise<void> {
    const routed = response as ModelResponse & {
      routeId?: string; role?: string; modelSpecId?: string; attempt?: number; tokenizerAssetDigest?: string
    };
    if (!routed.routeId || !routed.modelSpecId) return;
    const roles: readonly ModelExecutionRole[] = [
      "orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"
    ];
    const role = roles.includes(routed.role as ModelExecutionRole)
      ? routed.role as ModelExecutionRole : "orchestrator";
    await this.options.emit(session, "model.route_resolved", "runtime", {
      role,
      routeId: routed.routeId,
      modelSpecId: routed.modelSpecId,
      attempt: (routed.attempt ?? 0) + 1,
      ...(routed.tokenizerAssetDigest ? { tokenizerAssetDigest: routed.tokenizerAssetDigest } : {})
    });
  }

  private async commitFailure(
    session: RuntimeSession,
    turn: PreparedModelTurn,
    requestId: string,
    reservationId: string,
    startedAt: number,
    error: unknown
  ): Promise<void> {
    const attempts = typeof (error as { attempts?: unknown })?.attempts === "number"
      ? Math.max(1, Math.trunc((error as { attempts: number }).attempts)) : 1;
    const usage = failedModelUsage(
      session, session.services.gateway, requestId, turn.budget, performance.now() - startedAt, session.services.modelRole, attempts
    );
    // Failed attempts are measured after the provider lifecycle ends. Settle
    // them through the measured path so an unexpectedly high attempt count is
    // recorded as an overrun instead of leaving the durable reservation open.
    await this.options.budgets.commitMeasured(session, reservationId, consumedBudget(usage, turn.budget));
    await this.options.emit(session, "usage.recorded", "runtime", usage);
  }

}
