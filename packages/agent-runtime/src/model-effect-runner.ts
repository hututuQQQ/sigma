import {
  type BudgetAmounts,
  type ContextItem,
  type ModelExecutionRole,
  type ModelResponse,
  type RunOutcome
} from "agent-protocol";
import type { KernelEffect } from "agent-kernel";
import { RepositoryContextProvider, type ContextPlan } from "agent-context";
import { steeringRestart } from "./effect-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";
import {
  consumedBudget,
  failedModelUsage,
  successfulModelUsage
} from "./model-accounting.js";
import {
  modelFailureCode,
  modelFailureDiagnostics,
  modelFailureMessage,
  streamModelResponse
} from "./model-effect-support.js";
import {
  convergenceAdmissionFailure,
  deadlineForecast,
  type DeadlineForecast
} from "./convergence-policy.js";
import {
  budgetFailure,
  type PreparedModelTurn
} from "./model-budget-convergence.js";
import { ModelSummarizer } from "./model-summarizer.js";
import { prepareModelAttempt } from "./model-turn-preparation.js";
import { LongHorizonCoordinator } from "./long-horizon-coordinator.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import { finishSolvingBudgetBoundary } from "./solving-budget-boundary.js";

type RequestModelEffect = Extract<KernelEffect, { type: "request_model" }>;

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

export class ModelEffectRunner {
  private readonly repositoryContext: RepositoryContextProvider;
  private readonly summarizer: ModelSummarizer;
  private readonly longHorizon: LongHorizonCoordinator;

  constructor(
    private readonly options: EffectRunnerOptions,
    longHorizon?: LongHorizonCoordinator,
    private readonly reviews?: ReviewCoordinator
  ) {
    // Pre-model context is trusted, read-only runtime work. Keeping it on the
    // host filesystem prevents an indexing probe from consuming or closing the
    // shared sandbox broker used by model-requested tools and background work.
    this.repositoryContext = new RepositoryContextProvider();
    this.summarizer = new ModelSummarizer(options);
    this.longHorizon = longHorizon ?? new LongHorizonCoordinator(options);
  }

  async request(session: RuntimeSession, signal: AbortSignal, effect: RequestModelEffect): Promise<boolean> {
    const turnController = new AbortController();
    session.execution.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    const turnId = ++session.durable.modelTurn;
    let effectRevision = effect.revision;
    try {
      const openingDeadline = deadlineForecast(session);
      if (openingDeadline.stage !== "converge") {
        await this.longHorizon.prepareForMainModel(session, turnSignal);
      }
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
      return failure ? await this.finishBudgetBoundary(session, turnSignal, failure) : false;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "hook_gate_denied") throw error;
      if (modelFailureCode(error) === "budget_exhausted") {
        return await this.finishBudgetBoundary(session, turnSignal, budgetFailure(
          error instanceof Error ? error.message : "The remaining budget cannot fund a final model request."
        ));
      }
      await this.handleFailure(session, turnId, effectRevision, turnSignal, error);
      return false;
    }
  }

  private async finishBudgetBoundary(
    session: RuntimeSession,
    signal: AbortSignal,
    outcome: RunOutcome
  ): Promise<boolean> {
    if (!this.reviews) return await this.options.finish(session, outcome);
    return await finishSolvingBudgetBoundary(session, signal, outcome, {
      emit: this.options.emit,
      finish: this.options.finish,
      runtime: this.options.runtime,
      createArtifact: this.options.createArtifact
    });
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
      omittedHistoryTurns: plan.omittedHistoryTurns
        + (session.durable.state.contextArchive?.omittedHistoryTurns ?? 0),
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
  ): Promise<RunOutcome | null> {
    const openingForecast = deadlineForecast(session);
    let prepared = await prepareModelAttempt(
      this.options,
      this.repositoryContext,
      this.summarizer,
      session,
      turnId,
      signal,
      hookContext,
      openingForecast.stage === "converge" ? "final" : undefined
    );
    if (prepared.failure) return prepared.failure;
    let { turn, plan } = prepared;
    if (!turn || !plan) {
      throw new Error("Model turn preparation completed without a turn.");
    }
    const admissionFailure = convergenceAdmissionFailure(session, { kind: "model" });
    if (admissionFailure) return admissionFailure;
    let forecast = deadlineForecast(session);
    if (openingForecast.stage !== "converge" && forecast.stage === "converge") {
      prepared = await prepareModelAttempt(
        this.options,
        this.repositoryContext,
        this.summarizer,
        session,
        turnId,
        signal,
        hookContext,
        "final"
      );
      if (prepared.failure) return prepared.failure;
      ({ turn, plan } = prepared);
      if (!turn || !plan) {
        throw new Error("Deadline closeout preparation completed without a turn.");
      }
      forecast = deadlineForecast(session);
      const closeoutAdmissionFailure = convergenceAdmissionFailure(session, { kind: "model" });
      if (closeoutAdmissionFailure) return closeoutAdmissionFailure;
    }
    await this.options.emit(session, "model.prompt_materialized", "runtime", {
      turnId,
      effectRevision,
      messages: plan.promptFrameMessages,
      toolSchemaDigest: turn.toolSchemaDigest,
      requestDigest: turn.requestDigest,
      prefixMessageCount: Math.max(0, turn.messages.length - plan.promptFrameMessages.length),
      cacheMode: plan.cacheMode,
      promptState: turn.promptState,
      frameMode: turn.frameMode,
      toolChoice: turn.toolChoice ?? null
    });
    await this.longHorizon.markRepairTurnConsumed(session);
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "deadline.stage",
      stage: forecast.stage,
      ...(forecast.remainingMs === undefined ? {} : { remainingMs: forecast.remainingMs }),
      outputReserveTokens: turn.outputReserveTokens
    });
    await this.emitContextComposition(session, plan, forecast);
    signal.throwIfAborted();
    const requestId = `${session.durable.runId}:${turnId}`;
    const reservationId = await this.options.budgets.reserve(
      session, `model:${requestId}`, turn.budget.reserved
    );
    await this.runReserved(
      session, turnId, effectRevision, signal, turn, requestId, reservationId
    );
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
      contextWindowTokens: session.services.gateway.capabilities.contextWindowTokens,
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
