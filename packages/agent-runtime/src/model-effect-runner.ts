import {
  type BudgetAmounts,
  type ContextItem,
  type ModelExecutionRole,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolDefinition
} from "agent-protocol";
import type { KernelEffect } from "agent-kernel";
import { RepositoryContextProvider } from "agent-context";
import {
  failureDiagnostics as gatewayFailureDiagnostics,
  type ModelFailureDiagnostics,
  type ModelRouteConstraints
} from "agent-model";
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

type RequestModelEffect = Extract<KernelEffect, { type: "request_model" }>;

interface PreparedModelTurn {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  toolChoice?: ModelRequest["toolChoice"];
  budget: PreparedModelBudget;
}

interface ModelReservationState {
  settled: boolean;
  response?: ModelResponse; consumed?: Partial<BudgetAmounts>;
}

function errorCause(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
}

function modelFailureMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    const message = current.message.replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]");
    if (!messages.includes(message)) messages.push(message);
    current = errorCause(current);
  }
  if (messages.length === 0) return String(error);
  return messages.map((message, index) => `${index === 0 ? "" : "Caused by: "}${message}`).join("\n");
}

function modelFailureCode(error: unknown): string {
  let fallback = "model_error";
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      if (code !== "model_route_failed") return code;
      fallback = code;
    }
    current = errorCause(current);
  }
  return fallback;
}

function modelFailureDiagnostics(
  error: unknown,
  provider: string,
  model: string
): ModelFailureDiagnostics {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let diagnostics: ModelFailureDiagnostics | undefined;
  let attempts: number | undefined;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    diagnostics ??= gatewayFailureDiagnostics(current);
    const value = (current as { attempts?: unknown }).attempts;
    if (attempts === undefined && typeof value === "number") attempts = Math.max(1, Math.trunc(value));
    current = errorCause(current);
  }
  return {
    provider,
    model,
    ...diagnostics,
    ...(diagnostics?.retryAttempts === undefined && attempts !== undefined ? { retryAttempts: attempts } : {})
  };
}

interface ModelStreamLifecycle {
  doneReceived: boolean;
  lastEventType: string;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCall: boolean;
}

interface ModelStreamState extends ModelStreamLifecycle {
  response?: ModelResponse;
  contentDelta: string;
  reasoningDelta: string;
  lastFlush: number;
}

function newModelStreamState(): ModelStreamState {
  return {
    doneReceived: false,
    lastEventType: "none",
    hasContent: false,
    hasReasoning: false,
    hasToolCall: false,
    contentDelta: "",
    reasoningDelta: "",
    lastFlush: Date.now()
  };
}

function incompleteModelStreamError(
  provider: string,
  model: string,
  lifecycle: ModelStreamLifecycle,
  message = "Model stream ended without a final response."
): Error {
  const diagnostics: ModelFailureDiagnostics = {
    provider,
    model,
    category: "protocol",
    doneReceived: lifecycle.doneReceived,
    lastEventType: lifecycle.lastEventType,
    hasContent: lifecycle.hasContent,
    hasReasoning: lifecycle.hasReasoning,
    hasToolCall: lifecycle.hasToolCall,
    retryAttempts: 1
  };
  return Object.assign(new Error(
    `${message} provider=${provider}, model=${model}, doneReceived=${lifecycle.doneReceived}, lastEventType=${lifecycle.lastEventType}, hasContent=${lifecycle.hasContent}, hasToolCall=${lifecycle.hasToolCall}.`
  ), { code: "model_stream_incomplete", category: "protocol", diagnostics });
}

function observeModelStreamEvent(
  state: ModelStreamState,
  event: ModelStreamEvent,
  provider: string,
  model: string
): void {
  if (state.doneReceived) {
    throw incompleteModelStreamError(provider, model, state, "Model stream emitted data after its final response.");
  }
  state.lastEventType = event.type;
  if (event.type === "content") {
    state.hasContent = true;
    state.contentDelta += event.delta;
  } else if (event.type === "reasoning") {
    state.hasReasoning = true;
    state.reasoningDelta += event.delta;
  } else if (event.type === "tool_call") {
    state.hasToolCall = true;
  } else if (event.type === "done") {
    state.doneReceived = true;
    state.response = event.response;
    state.hasContent ||= event.response.message.content.length > 0;
    state.hasReasoning ||= Boolean(event.response.message.reasoningContent);
    state.hasToolCall ||= (event.response.message.toolCalls?.length ?? 0) > 0;
  }
}

async function flushModelStreamDeltas(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  turnId: number,
  state: ModelStreamState
): Promise<void> {
  if (state.contentDelta) {
    const delta = state.contentDelta;
    state.contentDelta = "";
    await options.emit(session, "model.delta", "runtime", { turnId, delta });
  }
  if (state.reasoningDelta) {
    const delta = state.reasoningDelta;
    state.reasoningDelta = "";
    await options.emit(session, "model.reasoning_delta", "runtime", { turnId, delta });
  }
  state.lastFlush = Date.now();
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
    const plan = await providerSizedPlan(session.services.gateway, {
      system: [...session.interaction.contextItems, ...hookContext],
      history: session.durable.state.messages,
      // Keep the stable system prefix cacheable. The evidence ledger is
      // current-run state and belongs in the dynamic suffix, where changes do
      // not invalidate static policy/context cache entries.
      dynamic: ledger ? [...dynamic, ledger] : dynamic,
      tools,
      outputReserveTokens: this.options.outputReserveTokens
    });
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
      this.options.outputReserveTokens,
      Math.max(0, session.durable.state.budget.limits.costMicroUsd
        - session.durable.state.budget.consumed.costMicroUsd
        - session.durable.state.budget.reserved.costMicroUsd)
    );
    const turn: PreparedModelTurn = {
      messages: plan.messages,
      tools,
      ...(repairPending ? { toolChoice: "required" } : {}),
      budget
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
      const response = await this.stream(
        session, turnId, turn.messages, turn.tools, turn.toolChoice, signal, turn.budget.routeConstraints, state
      );
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
    if (response.finishReason === "length") this.addContinuationContext(session);
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
    await this.options.budgets.commit(session, reservationId, consumedBudget(usage, turn.budget));
    await this.options.emit(session, "usage.recorded", "runtime", usage);
  }

  private async stream(
    session: RuntimeSession,
    turnId: number,
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
    toolChoice: ModelRequest["toolChoice"],
    signal: AbortSignal,
    routeConstraints: ModelRouteConstraints | undefined,
    state: ModelReservationState
  ): Promise<ModelResponse> {
    const streamState = newModelStreamState();
    const gateway = session.services.gateway as typeof session.services.gateway & {
      streamWithConstraints?(
        request: ModelRequest,
        constraints: ModelRouteConstraints
      ): AsyncIterable<ModelStreamEvent>;
    };
    const request = {
      messages,
      tools,
      ...(toolChoice ? { toolChoice } : {}),
      signal,
      maxOutputTokens: Math.min(this.options.outputReserveTokens, session.services.gateway.capabilities.maxOutputTokens)
    };
    const stream = routeConstraints && gateway.streamWithConstraints
      ? gateway.streamWithConstraints(request, routeConstraints)
      : gateway.stream(request);
    for await (const event of stream) {
      if (signal.aborted) throw signal.reason;
      observeModelStreamEvent(
        streamState, event, session.services.gateway.provider, session.services.gateway.model
      );
      if (Date.now() - streamState.lastFlush >= 33) {
        await flushModelStreamDeltas(this.options, session, turnId, streamState);
      }
    }
    if (!streamState.response) signal.throwIfAborted();
    await flushModelStreamDeltas(this.options, session, turnId, streamState);
    if (!streamState.response) {
      throw incompleteModelStreamError(
        session.services.gateway.provider,
        session.services.gateway.model,
        streamState
      );
    }
    state.response = streamState.response;
    return streamState.response;
  }

  private addContinuationContext(session: RuntimeSession): void {
    session.interaction.contextItems.push({
      id: `runtime:continue:${session.durable.seq}`,
      authority: "runtime",
      provenance: "model finish reason",
      content: "The previous response reached its output limit. Continue from the exact stopping point without repeating completed work.",
      tokenCount: 24,
      priority: 950
    });
  }
}
