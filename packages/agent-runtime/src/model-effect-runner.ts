import {
  type BudgetAmounts,
  type ContextItem,
  type ModelResponse,
  type RunOutcome
} from "agent-protocol";
import { lengthConvergenceRequired, type KernelEffect } from "agent-kernel";
import { RepositoryContextProvider, type ContextPlan } from "agent-context";
import { completionLimitations, steeringRestart } from "./effect-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";
import {
  consumedBudget,
  failedModelUsage,
  successfulModelUsage
} from "./model-accounting.js";
import { evidenceLedger } from "./model-evidence-ledger.js";
import { modelWorkingState } from "./model-working-state.js";
import {
  modelFailureCode,
  modelFailureDiagnostics,
  modelFailureMessage,
  streamModelResponse
} from "./model-effect-support.js";
import {
  convergenceAdmissionFailure,
  deadlineForecast,
  monotonicBudgetStage,
  type DeadlineForecast
} from "./convergence-policy.js";
import { candidateReviewerBudgetReserve, CompletionReserveQuoteUnavailableError,
  reviewerForSession } from "./reviewer-budget-reserve.js";
import { refreshValidationCapabilityProfile } from "./validation-capability-profile.js";
import {
  availableModelBudget,
  budgetFailure,
  defaultModelOutputReserveTokens,
  fitPreparedBudget,
  prepareBudgetedModelTurn,
  type BudgetStage,
  type PreparedModelTurn
} from "./model-budget-convergence.js";
import { maximumBudgetStage, stableBudgetPreparation } from "./model-budget-stability.js";
import { projectedToolCapabilities } from "./model-tool-capabilities.js";
import { turnDescriptorProjection } from "./model-turn-descriptors.js";
import {
  emitModelContextComposition,
  emitResolvedModelRoute
} from "./model-effect-telemetry.js";
type RequestModelEffect = Extract<KernelEffect, { type: "request_model" }>;
interface ModelReservationState {
  settled: boolean;
  response?: ModelResponse; consumed?: Partial<BudgetAmounts>;
}
interface PreparedAttempt {
  turn: PreparedModelTurn;
  plan: ContextPlan;
  forecast: DeadlineForecast;
  budgetStage: BudgetStage;
  resourceBudgetStage: BudgetStage;
}
function takeUnloadedSummary(session: RuntimeSession, plan: ContextPlan): ContextItem | undefined {
  const summary = plan.summary;
  if (!summary || session.interaction.loadedContextIds.has(summary.id)) return undefined;
  session.interaction.loadedContextIds.add(summary.id);
  return summary;
}

export class ModelEffectRunner {
  private readonly repositoryContext: RepositoryContextProvider;

  constructor(private readonly options: EffectRunnerOptions) {
    // Pre-model context is trusted, read-only runtime work. Keeping it on the
    // host filesystem prevents an indexing probe from consuming or closing the
    // shared sandbox broker used by model-requested tools and background work.
    this.repositoryContext = new RepositoryContextProvider();
  }

  async request(session: RuntimeSession, signal: AbortSignal, effect: RequestModelEffect): Promise<boolean> {
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
      if (!this.isCurrent(session, turnId, effectRevision)) return false;
      const failure = await this.attempt(session, turnId, effectRevision, turnSignal, hookResult.contextItems);
      return failure ? await this.options.finish(session, failure) : false;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "hook_gate_denied") throw error;
      if ((error as { code?: unknown })?.code === "budget_exhausted") {
        return await this.options.finish(session, budgetFailure(
          error instanceof Error ? error.message : "The remaining budget cannot fund a final model request."
        ));
      }
      await this.handleFailure(session, turnId, effectRevision, turnSignal, error);
      return false;
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

  private async prepareTurn(
    session: RuntimeSession,
    turnId: number,
    signal: AbortSignal,
    hookContext: readonly ContextItem[]
  ): Promise<PreparedAttempt | RunOutcome> {
    const {
      repairPhase, repairPending, modelDescriptors, descriptors, terminalDescriptors
    } = turnDescriptorProjection(this.options, session);
    // Once a completion prerequisite has new durable evidence, the model must
    // be able to stop naturally so the runtime-owned completion intent can be
    // generated. Other repair phases remain forced tool sub-turns.
    await refreshValidationCapabilityProfile(session, signal);
    const allowNaturalCompletion = repairPhase === "protected_completion"
      || completionLimitations(session) !== null;
    const ledger = evidenceLedger(session);
    const workingState = modelWorkingState(session);
    const query = [...session.durable.state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const dynamic = await this.repositoryContext.collect(session.identity.workspacePath, query, signal);
    const forecast = deadlineForecast(session);
    const available = availableModelBudget(session);
    const projectedCapabilities = projectedToolCapabilities(
      session, modelDescriptors, this.options.runtime.skills?.descriptors
    );
    const preparation = {
      session, forecast, turnId, descriptors, terminalDescriptors,
      capabilities: projectedCapabilities,
      dynamic: [...dynamic, workingState], hookContext,
      ledger, available, repairPending, allowNaturalCompletion,
      defaultOutputReserveTokens: this.options.runtime.outputReserveTokens
        ?? defaultModelOutputReserveTokens(session.services.gateway.capabilities)
    };
    const minimumStage = monotonicBudgetStage(forecast, "normal");
    const initial = await prepareBudgetedModelTurn({ ...preparation, budgetStage: minimumStage });
    const reviewer = reviewerForSession(this.options, session);
    let stable;
    try {
      stable = await stableBudgetPreparation(
        initial, forecast, minimumStage, lengthConvergenceRequired(session.durable.state),
        async (stage) => await prepareBudgetedModelTurn({ ...preparation, budgetStage: stage }),
        async () => await candidateReviewerBudgetReserve(session, reviewer, available.costMicroUsd), available
      );
    } catch (error) {
      if (error instanceof CompletionReserveQuoteUnavailableError) return { kind: "recoverable_failure", code: error.code, message: error.message };
      throw error;
    }
    const prepared = stable.prepared;
    const reviewerBudgetReserve = stable.reviewerReserve;
    const resourceBudgetStage = monotonicBudgetStage(forecast, stable.resourceStage);
    const budgetStage = maximumBudgetStage(resourceBudgetStage, stable.stage);
    const fittedBudget = fitPreparedBudget(
      prepared.turn.budget,
      available,
      budgetStage === "normal" ? Number.MAX_SAFE_INTEGER : 1,
      reviewerBudgetReserve
    );
    if (!fittedBudget) {
      return budgetFailure(
        `The remaining budget cannot fund one ${budgetStage === "terminal" ? "terminal " : ""}model request after bounded context compaction.`
      );
    }
    const admissionFailure = convergenceAdmissionFailure(session, {
      kind: "model",
      stage: budgetStage,
      futureBudgetReserve: reviewerBudgetReserve
    });
    if (admissionFailure) return admissionFailure;
    return {
      turn: { ...prepared.turn, budget: fittedBudget },
      plan: prepared.plan,
      forecast,
      budgetStage,
      resourceBudgetStage
    };
  }

  private async attempt(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal,
    hookContext: readonly ContextItem[]
  ): Promise<RunOutcome | null> {
    const prepared = await this.prepareTurn(session, turnId, signal, hookContext);
    if ("kind" in prepared) return prepared;
    const { turn, plan, forecast, budgetStage, resourceBudgetStage } = prepared;
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "model.tool_policy",
      turnId,
      effectRevision,
      allowedToolNames: [...new Set(turn.tools.map((tool) => tool.name))],
      terminalOnly: budgetStage === "terminal"
    });
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "deadline.stage",
      stage: forecast.stage,
      budgetStage,
      resourceBudgetStage,
      budgetStageSource: budgetStage === resourceBudgetStage ? "resource" : "action_debt",
      remainingMs: forecast.remainingMs,
      nextModelEstimateMs: forecast.nextModelEstimateMs,
      nextConvergenceModelEstimateMs: forecast.nextConvergenceModelEstimateMs,
      outputReserveTokens: turn.outputReserveTokens
    });
    await emitModelContextComposition(this.options.emit, this.options.runtime, session, plan, forecast);
    const summary = takeUnloadedSummary(session, plan);
    if (summary) {
      await this.options.emit(session, "context.compacted", "runtime", {
        item: summary,
        omittedHistoryTurns: plan.omittedHistoryTurns
      });
    }
    signal.throwIfAborted();
    const requestId = `${session.durable.runId}:${turnId}`;
    const reservationId = await this.options.budgets.reserve(session, `model:${requestId}`, turn.budget.reserved);
    await this.runReserved(session, turnId, effectRevision, signal, turn, requestId, reservationId);
    return null;
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
    await emitResolvedModelRoute(this.options.emit, session, response);
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
