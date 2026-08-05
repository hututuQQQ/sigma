import { randomUUID } from "node:crypto";
import type {
  ModelGateway,
  ModelMessage,
  ModelRequest,
  StrategyReset,
  UsageRecord
} from "agent-protocol";
import { mutationFrontierHasChanges } from "agent-kernel";
import {
  availableAuxiliaryBudget,
  mainBudgetWindow,
  reviewRepairActive
} from "./assurance-budget.js";
import type { BudgetController } from "./budget-controller.js";
import {
  auxiliaryCapacity,
  constrainedGateway,
  fallbackStrategy,
  fullAmounts,
  parsedStrategy,
  strategistTrigger,
  strategyBasisDigest,
  strategyMessages,
  type StrategyTrigger
} from "./long-horizon-strategy.js";
import {
  nextLongHorizonState,
  withAccountedAssurance
} from "./long-horizon-state.js";
import {
  consumedBudget,
  failedModelUsage,
  prepareModelBudget,
  successfulModelUsage,
  type PreparedModelBudget
} from "./model-accounting.js";
import { fitPreparedBudget } from "./model-budget-convergence.js";
import { deterministicSamplingOptions } from "./model-request-policy.js";
import { currentFrontierReview } from "./mutation-evidence.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

export {
  evidenceAttentionWindow,
  longHorizonCommitmentBasisDigest,
  longHorizonProgressBasisDigest,
  nextLongHorizonState,
  settledLongHorizonBatches
} from "./long-horizon-state.js";
export { strategyRebasedHistory } from "./long-horizon-projection.js";

interface LongHorizonCoordinatorOptions {
  runtime: RuntimeOptions;
  emit: RuntimeEventEmitter;
  budgets: BudgetController;
}

interface PreparedStrategist {
  gateway: ModelGateway;
  messages: ModelMessage[];
  maximumOutput: number;
  budget: PreparedModelBudget;
}

interface StrategistExecution {
  usage: UsageRecord;
  strategy: StrategyReset;
}

const MAX_STRATEGY_OUTPUT_TOKENS = 4_096;

function strategistAttemptAmounts(prepared: PreparedModelBudget) {
  const first = prepared.attemptReservations?.[0];
  return first
    ? fullAmounts({
        inputTokens: first.inputTokens,
        outputTokens: first.outputTokens,
        costMicroUsd: first.costMicroUsd ?? 0,
        modelTurns: 1
      })
    : fullAmounts(prepared.reserved);
}

function hasActivePlanWork(session: RuntimeSession): boolean {
  return session.durable.state.plan.nodes.some((node) =>
    node.status === "pending" || node.status === "in_progress"
    || node.status === "blocked");
}

function hasOpenWork(session: RuntimeSession): boolean {
  const frontier = session.durable.state.mutationFrontier;
  const unreviewedFrontier = mutationFrontierHasChanges(frontier)
    && currentFrontierReview(session)?.data.verdict !== "approved";
  return hasActivePlanWork(session) || unreviewedFrontier;
}

function crossedStrategyBand(session: RuntimeSession): boolean {
  const state = session.durable.state.longHorizon;
  if (state.resourceBandTriggered || state.assurance.strategistMode !== "adaptive"
    || !hasOpenWork(session)) return false;
  const { available, capacity } = mainBudgetWindow(session);
  const percentages = ([
    "inputTokens",
    "outputTokens",
    "costMicroUsd",
    "modelTurns",
    "toolCalls"
  ] as const).map((dimension) => capacity[dimension] <= 0
    ? 100
    : Math.floor(available[dimension] * 100 / capacity[dimension]));
  return Math.min(...percentages) <= state.assurance.strategyRemainingPercent;
}

export class LongHorizonCoordinator {
  constructor(private readonly options: LongHorizonCoordinatorOptions) {}

  async refresh(session: RuntimeSession): Promise<void> {
    const next = nextLongHorizonState(session);
    if (JSON.stringify(next) === JSON.stringify(session.durable.state.longHorizon)) return;
    await this.options.emit(session, "long_horizon.updated", "runtime", {
      state: next,
      reason: "batch_settled"
    });
  }

  async prepareForMainModel(session: RuntimeSession, signal: AbortSignal): Promise<void> {
    await this.refresh(session);
    if (crossedStrategyBand(session)) {
      await this.options.emit(session, "long_horizon.updated", "runtime", {
        state: {
          ...session.durable.state.longHorizon,
          resourceBandTriggered: true
        },
        reason: "resource_band_triggered"
      });
    }
    const trigger = strategistTrigger(session);
    if (!trigger) return;
    await this.runStrategist(session, signal, trigger);
  }

  /**
   * A user-input suspension is a semantic claim that the remaining fact or
   * decision belongs to the user. When work is still objectively open, give a
   * fresh-context strategist one chance to audit that claim before accepting
   * it as terminal. This does not decide the task, remove tools, or consult a
   * wall clock; a repeated request after the one permitted strategy review is
   * still honored.
   */
  async deferInputRequestForStrategy(
    session: RuntimeSession,
    message: string
  ): Promise<boolean> {
    await this.refresh(session);
    const state = session.durable.state.longHorizon;
    if (!hasActivePlanWork(session)
      || state.assurance.strategistMode === "off"
      || state.assurance.strategistCalls >= 1
      || state.strategyRequested
      || state.strategy !== undefined) return false;
    await this.options.emit(session, "long_horizon.updated", "runtime", {
      state: {
        ...state,
        strategyRequested: true
      },
      reason: "input_request_audit"
    });
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "completion.advisory",
      message: [
        "The proposed user-input suspension has not yet received an independent strategy review.",
        "A fresh-context strategist will assess whether the missing item is genuinely user-owned or can be derived with a bounded next action.",
        "After that review, continue autonomously when possible; repeat request_user_input only if the user must actually decide or supply the fact.",
        `Proposed request: ${message}`
      ].join(" ")
    });
    return true;
  }

  async markRepairTurnConsumed(session: RuntimeSession): Promise<void> {
    const state = session.durable.state.longHorizon;
    const remaining = state.assurance.protectedRepairTurnsRemaining;
    if (!reviewRepairActive(session) || remaining <= 0) return;
    await this.options.emit(session, "long_horizon.updated", "runtime", {
      state: {
        ...state,
        assurance: {
          ...state.assurance,
          repairEpisodes: Math.min(
            state.assurance.repairRounds,
            Math.max(1, state.assurance.repairEpisodes)
          ),
          protectedRepairTurnsRemaining: remaining - 1
        }
      },
      reason: "repair_capacity_consumed"
    });
  }

  async accountReview(session: RuntimeSession): Promise<void> {
    const next = withAccountedAssurance(session, session.durable.state.longHorizon);
    if (JSON.stringify(next.assurance)
      === JSON.stringify(session.durable.state.longHorizon.assurance)) return;
    await this.options.emit(session, "long_horizon.updated", "runtime", {
      state: next,
      reason: "review_accounted"
    });
  }

  private async runStrategist(
    session: RuntimeSession,
    signal: AbortSignal,
    trigger: StrategyTrigger
  ): Promise<void> {
    const prepared = await this.prepareStrategist(session, trigger);
    if (!prepared) return;
    const requestId = `strategy:${session.durable.runId}:${randomUUID()}`;
    const reservationId = await this.options.budgets.reserve(
      session,
      `model:${requestId}`,
      prepared.budget.reserved
    );
    let execution: StrategistExecution;
    try {
      execution = await this.invokeStrategist(
        session,
        signal,
        requestId,
        prepared,
        trigger
      );
    } catch (error) {
      await this.options.budgets.release(session, reservationId);
      throw error;
    }
    await this.options.budgets.commitMeasured(
      session,
      reservationId,
      consumedBudget(execution.usage, prepared.budget)
    );
    await this.options.emit(session, "usage.recorded", "runtime", execution.usage);
    await this.persistStrategy(session, execution.strategy);
  }

  private async prepareStrategist(
    session: RuntimeSession,
    trigger: StrategyTrigger
  ): Promise<PreparedStrategist | undefined> {
    const gateway = this.options.runtime.gatewayForRole?.("planner", session.services.profile)
      ?? session.services.gateway;
    const messages = strategyMessages(session, trigger);
    const maximumOutput = Math.min(
      MAX_STRATEGY_OUTPUT_TOKENS,
      gateway.capabilities.maxOutputTokens
    );
    const basis = strategyBasisDigest(session);
    let prepared: PreparedModelBudget;
    try {
      prepared = await prepareModelBudget(
        gateway,
        messages,
        [],
        maximumOutput,
        availableAuxiliaryBudget(session).costMicroUsd
      );
    } catch {
      await this.persistStrategy(session, fallbackStrategy(
        session.durable.state.longHorizon,
        basis,
        trigger,
        "A fresh strategist could not be prepared; use the bounded durable facts to pivot."
      ));
      return undefined;
    }
    // Routed gateways reserve the complete retry chain in `reserved`. The
    // strategist is deliberately capped to one attempt below, so protect the
    // reviewer pool against that same one-attempt amount rather than treating
    // every possible route retry as one oversized auxiliary call.
    const capacity = auxiliaryCapacity(session, strategistAttemptAmounts(prepared));
    const fitted = capacity ? fitPreparedBudget(prepared, capacity, 1) : null;
    if (!fitted) {
      // Strategist is lowest priority. Skipping it is observable but does not
      // consume the permitted strategist invocation for this checkpoint.
      return undefined;
    }
    return { gateway, messages, maximumOutput, budget: fitted };
  }

  private async invokeStrategist(
    session: RuntimeSession,
    signal: AbortSignal,
    requestId: string,
    prepared: PreparedStrategist,
    trigger: StrategyTrigger
  ): Promise<StrategistExecution> {
    const startedAt = performance.now();
    const basis = strategyBasisDigest(session);
    try {
      signal.throwIfAborted();
      const request: ModelRequest = {
        sessionId: session.identity.sessionId,
        signal,
        tools: [],
        toolChoice: "none",
        ...deterministicSamplingOptions(prepared.gateway),
        maxOutputTokens: prepared.maximumOutput,
        messages: prepared.messages
      };
      const constrained = constrainedGateway(prepared.gateway);
      const response = prepared.budget.routeConstraints && constrained.completeWithConstraints
        ? await constrained.completeWithConstraints(request, prepared.budget.routeConstraints)
        : await prepared.gateway.complete(request);
      const usage = successfulModelUsage(
        session,
        prepared.gateway,
        requestId,
        { messages: prepared.messages, tools: [] },
        response,
        prepared.budget,
        performance.now() - startedAt,
        "planner"
      );
      const strategy = parsedStrategy(
        response.message.content,
        basis,
        trigger
      ) ?? fallbackStrategy(
        session.durable.state.longHorizon,
        basis,
        trigger,
        "The strategist response was invalid; pivot using the durable receipt facts."
      );
      return { usage, strategy };
    } catch (error) {
      if (signal.aborted) throw error;
      const attempts = typeof (error as { attempts?: unknown })?.attempts === "number"
        ? Math.max(1, Math.trunc((error as { attempts: number }).attempts))
        : 1;
      const usage = failedModelUsage(
        session,
        prepared.gateway,
        requestId,
        prepared.budget,
        performance.now() - startedAt,
        "planner",
        attempts
      );
      const strategy = fallbackStrategy(
        session.durable.state.longHorizon,
        basis,
        trigger,
        "The fresh strategist call failed; pivot using the bounded durable facts instead of repeating the prior route."
      );
      return { usage, strategy };
    }
  }

  private async persistStrategy(
    session: RuntimeSession,
    strategy: StrategyReset
  ): Promise<void> {
    const accounted = withAccountedAssurance(
      session,
      session.durable.state.longHorizon
    );
    await this.options.emit(session, "long_horizon.updated", "runtime", {
      state: {
        ...accounted,
        strategy,
        strategyRequested: false
      },
      reason: "strategy_reset"
    });
  }
}
