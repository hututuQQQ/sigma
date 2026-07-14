import type {
  ModelToolCall,
  RunOutcome,
  ToolDescriptor,
  ToolOutcome,
  ToolReceipt
} from "agent-protocol";
import { decide, type ActiveModelTurn, type KernelEffect } from "agent-kernel";
import { loadNestedInstructions } from "agent-context";
import {
  failed, requestTargets, requiresInstructionReplan, steeringRestart
} from "./effect-helpers.js";
import {
  attemptFromEffect,
  childOutcomeEvidence,
  turnPayload,
  type ExecuteToolEffect,
  type ToolAttempt
} from "./effect-runner-helpers.js";
import { ModelEffectRunner } from "./model-effect-runner.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";
import type { BudgetController } from "./budget-controller.js";
import type { RuntimeControlService } from "./runtime-control.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import type { ReviewerPort } from "./reviewer.js";
import type { RuntimeHookCoordinator } from "./runtime-hooks.js";
import { ToolExecutionMonitor } from "./tool-execution-monitor.js";
import { ToolTransactionRunner } from "./tool-transaction-runner.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RunSuspensionContext } from "./runtime-session-finish.js";

export interface EffectRunnerOptions {
  runtime: RuntimeOptions;
  maxParallelTools: number;
  permissionMode: "ask" | "auto" | "deny";
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

type DurableToolReceipt = ToolReceipt & { outcome: ToolOutcome };

function durableToolReceipt(receipt: ToolReceipt): DurableToolReceipt {
  const diagnosticCodes = [...new Set([
    ...(receipt.outcome?.diagnosticCodes ?? []),
    ...receipt.diagnostics
  ])];
  return {
    ...receipt,
    outcome: {
      status: receipt.ok ? "succeeded" : "failed",
      output: receipt.output,
      diagnosticCodes
    }
  };
}

export class EffectRunner {
  private readonly models: ModelEffectRunner;
  private readonly reviews: ReviewCoordinator;
  private readonly execution: ToolExecutionMonitor;
  private readonly transactions: ToolTransactionRunner;

  constructor(private readonly options: EffectRunnerOptions) {
    this.models = new ModelEffectRunner(options);
    this.reviews = new ReviewCoordinator(
      options.reviewerForSession ?? (() => options.reviewer),
      options.emit,
      options.budgets
    );
    this.execution = new ToolExecutionMonitor(options);
    this.transactions = new ToolTransactionRunner(options, this.execution);
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

  async run(session: RuntimeSession, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.suspendForLostProcesses(session)) return;
      const effects = decide(session.durable.state);
      const terminal = effects.find((effect): effect is Extract<KernelEffect, { type: "finish_run" }> => effect.type === "finish_run");
      if (terminal) {
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
            continue;
          }
          for (const [index, value] of children.evidence.entries()) {
            await this.options.emit(session, "evidence.recorded", "runtime", childOutcomeEvidence(session, value, index));
          }
          outcome = { ...outcome, evidence: [...session.durable.state.evidence] };
          outcomeRevision = session.durable.state.revision;
        }
        if (await this.options.finish(session, outcome, outcomeRevision)) return;
        continue;
      }
      if (effects.some((effect) => effect.type === "publish_outcome")) return;
      const model = effects.find((effect): effect is Extract<KernelEffect, { type: "request_model" }> => effect.type === "request_model");
      if (model) {
        await this.models.request(session, signal, model);
        continue;
      }
      const tools = effects.filter((effect): effect is ExecuteToolEffect => effect.type === "execute_tool");
      if (tools.length > 0) {
        await this.executeTools(session, tools.map(attemptFromEffect), signal);
        continue;
      }
      return;
    }
    throw signal.reason ?? new Error("Run cancelled.");
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

  private async executeTools(session: RuntimeSession, attempts: ToolAttempt[], signal: AbortSignal): Promise<void> {
    const turnController = session.execution.turnController ?? new AbortController();
    session.execution.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    if (steeringRestart(turnSignal)) return;
    try {
      let loadedInstructions = false;
      for (const { call } of attempts) {
        const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
        if (descriptor && await this.loadInstructions(session, call, descriptor)) loadedInstructions = true;
      }
      const isCompletion = ({ call }: ToolAttempt): boolean => Boolean(
        this.options.runtime.tools.descriptors().find((item) => item.name === call.name)
          ?.possibleEffects.includes("outcome.propose")
      );
      const pending = attempts.filter((attempt) => !isCompletion(attempt));
      const completions = attempts.filter(isCompletion);
      const executeAttempt = async (attempt: ToolAttempt): Promise<void> => {
        const { call, modelTurn } = attempt;
        const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
        if (loadedInstructions && descriptor && requiresInstructionReplan(descriptor)) {
          const startedAt = new Date().toISOString();
          await this.options.emit(session, "tool.requested", "runtime", {
            callId: call.id, name: call.name, arguments: call.arguments, ...turnPayload(modelTurn)
          });
          await this.emitReceipt(session, failed(
            call,
            startedAt,
            "New nested project instructions were loaded. Re-evaluate the request and propose a new tool call that follows them.",
            "nested_instructions_require_replan"
          ), modelTurn);
          return;
        }
        const receipt = await this.transactions.execute(session, attempt, turnSignal);
        await this.emitReceipt(session, receipt, modelTurn);
      };
      while (pending.length > 0) {
        if (steeringRestart(turnSignal)) return;
        const batch = pending.splice(0, this.options.maxParallelTools);
        await Promise.all(batch.map(executeAttempt));
        if (await this.suspendForCheckpointRecovery(session)) return;
      }
      for (const completion of completions) {
        if (steeringRestart(turnSignal)) return;
        await executeAttempt(completion);
      }
    } finally {
      if (session.execution.turnController === turnController) session.execution.turnController = null;
    }
  }

  private async suspendForCheckpointRecovery(session: RuntimeSession): Promise<boolean> {
    const recovery = session.recovery.openCheckpointRecovery;
    if (!recovery) return false;
    return await this.options.finish(session, {
      kind: "needs_input",
      requestId: `checkpoint:${recovery.checkpointId}`,
      message: `Mutation checkpoint '${recovery.checkpointId}' contains an interrupted delta. Choose safe restore or keep before continuing.`
    }, undefined, { checkpointId: recovery.checkpointId, choices: ["restore", "keep"] });
  }

  private async loadInstructions(
    session: RuntimeSession,
    call: ModelToolCall,
    descriptor: ToolDescriptor
  ): Promise<boolean> {
    const discovered = await Promise.all(requestTargets(call, descriptor).map(async (targetPath) =>
      await loadNestedInstructions({ workspacePath: session.identity.workspacePath, targetPath })));
    const unseen = discovered.flat().filter((item) => !session.interaction.loadedContextIds.has(item.id));
    for (const item of unseen) {
      session.interaction.loadedContextIds.add(item.id);
      session.interaction.contextItems.push(item);
    }
    if (unseen.length === 0) return false;
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "nested_instructions_loaded",
      callId: call.id,
      provenance: unseen.map((item) => item.provenance),
      items: unseen,
      affectsMutation: descriptor.possibleEffects.includes("filesystem.write")
    });
    return true;
  }

  private async emitReceipt(session: RuntimeSession, receipt: ToolReceipt, modelTurn: ActiveModelTurn): Promise<void> {
    const name = session.durable.state.pendingTools.find((item) => item.request.callId === receipt.callId
      && item.modelTurn.turnId === modelTurn.turnId
      && item.modelTurn.effectRevision === modelTurn.effectRevision)?.request.name ?? "tool";
    const durableReceipt = durableToolReceipt(receipt);
    await this.options.emit(session, receipt.ok ? "tool.completed" : "tool.failed", "tool", {
      ...durableReceipt, name, ...turnPayload(modelTurn)
    });
    for (const evidence of receipt.evidence ?? []) {
      await this.options.emit(session, "evidence.recorded", "tool", evidence);
    }
    try {
      await this.options.hooks.dispatch(session, "post_tool", {
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        callId: receipt.callId,
        toolName: name,
        ok: receipt.ok,
        diagnostics: receipt.diagnostics,
        actualEffects: receipt.actualEffects ?? receipt.observedEffects,
        evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId),
        artifactRefs: receipt.artifactRefs ?? []
      }, session.execution.controller?.signal ?? new AbortController().signal);
      await this.reviews.maybeReview(
        session,
        session.execution.controller?.signal ?? new AbortController().signal,
        name === "request_review"
      );
    } finally {
      await this.transactions.settleBudgetsAfterReceipt(session);
    }
  }

}
