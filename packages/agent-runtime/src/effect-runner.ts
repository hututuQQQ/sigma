import type { RunOutcome } from "agent-protocol";
import { decide, type KernelEffect } from "agent-kernel";
import {
  attemptFromEffect,
  childOutcomeEvidence,
  type ExecuteToolEffect
} from "./effect-runner-helpers.js";
import { ModelEffectRunner } from "./model-effect-runner.js";
import { convergenceAdmissionFailure } from "./convergence-policy.js";
import type { RuntimeOptions, RuntimePermissionMode, RuntimeSession } from "./types.js";
import type { BudgetController } from "./budget-controller.js";
import type { RuntimeControlService } from "./runtime-control.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import type { ReviewerPort } from "./reviewer.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import { ToolExecutionMonitor } from "./tool-execution-monitor.js";
import { ToolTransactionRunner } from "./tool-transaction-runner.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RunSuspensionContext } from "./runtime-session-finish.js";
import { ToolBatchCoordinator } from "./tool-batch-coordinator.js";

export interface EffectRunnerOptions {
  runtime: RuntimeOptions;
  maxParallelTools: number;
  permissionMode: RuntimePermissionMode;
  outputReserveTokens: number;
  emit: RuntimeEventEmitter;
  finish(
    session: RuntimeSession,
    outcome: RunOutcome,
    outcomeRevision?: number,
    suspensionContext?: RunSuspensionContext
  ): Promise<boolean>;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  control: RuntimeControlService;
  budgets: BudgetController;
  reviewer: ReviewerPort;
  reviewerForSession?: (session: RuntimeSession) => ReviewerPort;
  hooks: RuntimeHookCoordinator;
}

export class EffectRunner {
  private readonly models: ModelEffectRunner;
  private readonly reviews: ReviewCoordinator;
  private readonly execution: ToolExecutionMonitor;
  private readonly transactions: ToolTransactionRunner;
  private readonly toolBatches: ToolBatchCoordinator;

  constructor(private readonly options: EffectRunnerOptions) {
    this.models = new ModelEffectRunner(options);
    this.reviews = new ReviewCoordinator(
      options.reviewerForSession ?? (() => options.reviewer),
      options.emit,
      options.budgets
    );
    this.execution = new ToolExecutionMonitor(options);
    this.transactions = new ToolTransactionRunner(options, this.execution);
    this.toolBatches = new ToolBatchCoordinator(options, this.reviews, this.transactions);
  }

  async waitForQuiescence(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.execution.waitForQuiescence(sessionId, signal);
  }

  async withWorkspaceWriteLock<T>(session: RuntimeSession, action: () => Promise<T>): Promise<T> {
    return await this.transactions.withWorkspaceWriteLock(session, action);
  }

  async settleMutationBudgets(session: RuntimeSession): Promise<void> {
    await this.transactions.settleBudgetsAfterReceipt(session);
  }

  private async requestModel(
    session: RuntimeSession,
    signal: AbortSignal,
    effect: Extract<KernelEffect, { type: "request_model" }>
  ): Promise<boolean> {
    const failure = convergenceAdmissionFailure(session, { kind: "model" });
    if (failure) return await this.options.finish(session, failure);
    return await this.models.request(session, signal, effect);
  }

  private async requestTools(
    session: RuntimeSession,
    signal: AbortSignal,
    effects: ExecuteToolEffect[]
  ): Promise<boolean> {
    const descriptors = this.options.runtime.tools.descriptors();
    const terminalOnly = effects.every((effect) => descriptors
      .find((item) => item.name === effect.request.name)
          ?.possibleEffects.every((item) => item === "outcome.propose" || item === "outcome.report_blocked"
            || item === "outcome.request_input") === true);
    const failure = convergenceAdmissionFailure(session, {
      kind: "tool", count: effects.length, terminalOnly
    });
    if (failure) return await this.options.finish(session, failure);
    await this.toolBatches.execute(session, effects.map(attemptFromEffect), signal);
    return false;
  }

  async run(session: RuntimeSession, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.suspendForLostProcesses(session)) return;
      const effects = decide(session.durable.state);
      const terminal = effects.find((effect): effect is Extract<KernelEffect, { type: "finish_run" }> => effect.type === "finish_run");
      if (terminal) {
        const finished = await this.finishTerminalEffect(session, terminal, signal);
        if (finished) return;
        continue;
      }
      if (effects.some((effect) => effect.type === "publish_outcome")) return;
      const model = effects.find((effect): effect is Extract<KernelEffect, { type: "request_model" }> => effect.type === "request_model");
      if (model) {
        if (await this.requestModel(session, signal, model)) return;
        continue;
      }
      const tools = effects.filter((effect): effect is ExecuteToolEffect => effect.type === "execute_tool");
      if (tools.length > 0) {
        if (await this.requestTools(session, signal, tools)) return;
        continue;
      }
      return;
    }
    throw signal.reason ?? new Error("Run cancelled.");
  }

  private async finishTerminalEffect(
    session: RuntimeSession,
    terminal: Extract<KernelEffect, { type: "finish_run" }>,
    signal: AbortSignal
  ): Promise<boolean> {
    let outcome = terminal.outcome;
    let outcomeRevision = terminal.revision;
    if (outcome.kind === "completed" && this.options.runtime.joinChildren) {
      const children = await this.options.runtime.joinChildren(session.identity.sessionId, signal);
      if (children.failures.length > 0) {
        await this.options.emit(session, "diagnostic", "runtime", {
          kind: "child.join_failed",
          failures: children.failures,
          evidence: children.evidence
        });
        return false;
      }
      for (const [index, value] of children.evidence.entries()) {
        await this.options.emit(session, "evidence.recorded", "runtime", childOutcomeEvidence(session, value, index));
      }
      outcome = { ...outcome, evidence: [...session.durable.state.evidence] };
      outcomeRevision = session.durable.state.revision;
    }
    return await this.options.finish(session, outcome, outcomeRevision);
  }

  private async suspendForLostProcesses(session: RuntimeSession): Promise<boolean> {
    const active = new Set(session.durable.state.activeProcessIds);
    const lost = (this.options.runtime.execution?.lostProcessHandles ?? [])
      .filter((handle) => active.has(handle.id));
    if (lost.length === 0) return false;
    for (const handle of lost) {
      session.execution.processHandles?.delete(handle.id);
      await this.options.emit(session, "process.lost", "runtime", {
        processId: handle.id,
        reason: "The sigma-exec broker connection ended and its process tree was terminated."
      });
    }
    return await this.options.finish(session, {
      kind: "needs_input",
      requestId: `process-recovery:${lost[0]!.id}`,
      message: "A background process was lost when the execution broker ended. It was not replayed; review its durable output before continuing."
    }, undefined, { processIds: lost.map((handle) => handle.id) });
  }
}
