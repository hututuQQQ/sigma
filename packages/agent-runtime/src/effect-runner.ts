import type {
  AgentEventEnvelope,
  AgentEventType,
  ContextAuthority,
  ModelToolCall,
  RunOutcome,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import { decide, type ActiveModelTurn, type KernelEffect } from "agent-kernel";
import { loadNestedInstructions } from "agent-context";
import { gitPorcelain } from "agent-platform";
import { isToolAllowed, ResourceLockManager } from "agent-tools";
import {
  abortable, completionFailure, failed, fileFingerprint, lockKeys, mergeDelta,
  porcelainEntries, requestTargets, requiresInstructionReplan, steeringRestart,
  workspaceDelta, writeScopeFailure
} from "./effect-helpers.js";
import { ModelEffectRunner } from "./model-effect-runner.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

type Emit = (
  session: RuntimeSession,
  type: AgentEventType,
  authority: Exclude<ContextAuthority, "external_verifier">,
  value: unknown
) => Promise<AgentEventEnvelope>;

type ExecuteToolEffect = Extract<KernelEffect, { type: "execute_tool" }>;
interface ToolAttempt { call: ModelToolCall; modelTurn: ActiveModelTurn }

function attemptFromEffect(effect: ExecuteToolEffect): ToolAttempt {
  return {
    call: { id: effect.request.callId, name: effect.request.name, arguments: effect.request.arguments },
    modelTurn: effect.modelTurn
  };
}

function turnPayload(modelTurn: ActiveModelTurn): ActiveModelTurn {
  return { turnId: modelTurn.turnId, effectRevision: modelTurn.effectRevision };
}

export interface EffectRunnerOptions {
  runtime: RuntimeOptions;
  maxParallelTools: number;
  permissionMode: "ask" | "auto" | "deny";
  outputReserveTokens: number;
  emit: Emit;
  finish(session: RuntimeSession, outcome: RunOutcome, outcomeRevision?: number): Promise<boolean>;
  createArtifact(sessionId: string, content: string): Promise<string>;
}

export class EffectRunner {
  private readonly locks = new ResourceLockManager();
  private readonly unsettled = new Map<string, Promise<void>>();
  private readonly sessionUnsettled = new Map<string, Set<Promise<void>>>();
  private readonly models: ModelEffectRunner;

  constructor(private readonly options: EffectRunnerOptions) {
    this.models = new ModelEffectRunner(options);
  }

  async waitForQuiescence(sessionId: string, signal?: AbortSignal): Promise<void> {
    while (this.sessionUnsettled.get(sessionId)?.size) {
      const pending = Promise.all([...this.sessionUnsettled.get(sessionId)!]).then(() => undefined);
      await (signal ? abortable(pending, signal) : pending);
    }
  }

  async run(session: RuntimeSession, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const effects = decide(session.state);
      const terminal = effects.find((effect): effect is Extract<KernelEffect, { type: "finish_run" }> => effect.type === "finish_run");
      if (terminal) {
        let outcome = terminal.outcome;
        if (outcome.kind === "completed" && this.options.runtime.joinChildren) {
          const children = await this.options.runtime.joinChildren(session.sessionId, signal);
          if (children.failures.length > 0) {
            await this.options.emit(session, "diagnostic", "runtime", {
              kind: "child.join_failed",
              failures: children.failures,
              evidence: children.evidence
            });
            continue;
          }
          outcome = { ...outcome, evidence: [...outcome.evidence, ...children.evidence] };
        }
        if (await this.options.finish(session, outcome, terminal.revision)) return;
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

  private async executeTools(session: RuntimeSession, attempts: ToolAttempt[], signal: AbortSignal): Promise<void> {
    const turnController = session.turnController ?? new AbortController();
    session.turnController = turnController;
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
        const receipt = await this.executeTool(session, attempt, turnSignal);
        await this.emitReceipt(session, receipt, modelTurn);
      };
      while (pending.length > 0) {
        if (steeringRestart(turnSignal)) return;
        const batch = pending.splice(0, this.options.maxParallelTools);
        await Promise.all(batch.map(executeAttempt));
      }
      for (const completion of completions) {
        if (steeringRestart(turnSignal)) return;
        await executeAttempt(completion);
      }
    } finally {
      if (session.turnController === turnController) session.turnController = null;
    }
  }

  private async executeTool(session: RuntimeSession, attempt: ToolAttempt, signal: AbortSignal): Promise<ToolReceipt> {
    const { call, modelTurn } = attempt;
    const startedAt = new Date().toISOString();
    const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
    if (!descriptor) return failed(call, startedAt, `Unknown tool '${call.name}'.`, "unknown_tool");
    await this.options.emit(session, "tool.requested", "runtime", {
      callId: call.id, name: call.name, arguments: call.arguments, ...turnPayload(modelTurn)
    });
    const cached = session.state.receipts.find((item) => item.callId === call.id);
    if (cached && descriptor.idempotent) return { ...cached, diagnostics: [...cached.diagnostics, "reused_idempotent_receipt"], completedAt: new Date().toISOString() };
    if (!isToolAllowed(descriptor, session.mode)) return failed(call, startedAt, `Tool '${call.name}' is not allowed in ${session.mode} mode.`, "mode_denied");
    const scopeError = writeScopeFailure(session, call, descriptor, startedAt);
    if (scopeError) return scopeError;
    const completionError = completionFailure(session, call, descriptor, startedAt);
    if (completionError) return completionError;
    try {
      const restored = session.state.pendingTools.find((item) => item.request.callId === call.id)?.approval;
      const decision = restored === "allowed" ? "allow" : await this.approval(session, descriptor, call.id, modelTurn, signal);
      if (decision === "deny") return failed(call, startedAt, "Tool request denied.", "permission_denied");
      const keys = lockKeys(session, descriptor);
      await this.awaitSettled(keys, signal);
      return await this.locks.withLocks(keys, async () =>
        await this.executeLocked(session, call, modelTurn, descriptor, signal, keys));
    } catch (error) {
      return failed(call, startedAt, error instanceof Error ? error.message : String(error), signal.aborted ? "tool_cancelled" : "tool_exception");
    }
  }

  private async loadInstructions(
    session: RuntimeSession,
    call: ModelToolCall,
    descriptor: ToolDescriptor
  ): Promise<boolean> {
    const discovered = await Promise.all(requestTargets(call, descriptor).map(async (targetPath) =>
      await loadNestedInstructions({ workspacePath: session.workspacePath, targetPath })));
    const unseen = discovered.flat().filter((item) => !session.loadedContextIds.has(item.id));
    for (const item of unseen) {
      session.loadedContextIds.add(item.id);
      session.contextItems.push(item);
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

  private async executeLocked(
    session: RuntimeSession,
    call: ModelToolCall,
    modelTurn: ActiveModelTurn,
    descriptor: ToolDescriptor,
    signal: AbortSignal,
    resourceKeys: string[]
  ): Promise<ToolReceipt> {
    await this.options.emit(session, "tool.started", "runtime", {
      callId: call.id, name: call.name, ...turnPayload(modelTurn)
    });
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason ?? new Error("Run cancelled."));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`Tool '${call.name}' exceeded ${descriptor.timeoutMs}ms.`), { name: "TimeoutError" })), descriptor.timeoutMs);
    const idleTimeoutMs = descriptor.idleTimeoutMs ?? descriptor.timeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = (): void => {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(Object.assign(
        new Error(`Tool '${call.name}' was idle for ${idleTimeoutMs}ms.`), { name: "TimeoutError" }
      )), idleTimeoutMs);
      idleTimer.unref();
    };
    heartbeat();
    try {
      const observes = descriptor.possibleEffects.some((effect) => ["filesystem.write", "process.spawn", "destructive", "validation"].includes(effect));
      const before = observes ? await this.gitState(session, controller.signal) : null;
      const execution = this.options.runtime.tools.execute({ callId: call.id, name: call.name, arguments: call.arguments }, {
        sessionId: session.sessionId,
        runId: session.runId,
        workspacePath: session.workspacePath,
        runMode: session.mode,
        signal: controller.signal,
        heartbeat,
        progress: async (update) => {
          heartbeat();
          await this.options.emit(session, "tool.progress", "tool", {
            callId: call.id, name: call.name, ...turnPayload(modelTurn), ...update
          });
        },
        createArtifact: async (artifact) => await this.options.createArtifact(session.sessionId, artifact.content)
      });
      let receipt: ToolReceipt;
      try {
        receipt = await abortable(execution, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) this.quarantine(session.sessionId, resourceKeys, execution);
        throw error;
      }
      if (!before) return receipt;
      const after = await this.gitState(session, controller.signal);
      if (!after) return receipt;
      const observed = workspaceDelta(before, after);
      const changed = observed.added.length + observed.modified.length + observed.deleted.length > 0;
      return {
        ...receipt,
        workspaceDelta: mergeDelta(receipt.workspaceDelta, observed),
        observedEffects: changed && !receipt.observedEffects.includes("filesystem.write") ? [...receipt.observedEffects, "filesystem.write"] : receipt.observedEffects
      };
    } finally {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async awaitSettled(keys: string[], signal: AbortSignal): Promise<void> {
    const pending = [...new Set(keys.flatMap((key) => this.unsettled.get(key) ?? []))];
    if (pending.length > 0) await abortable(Promise.all(pending).then(() => undefined), signal);
  }

  private quarantine(sessionId: string, keys: string[], operation: Promise<unknown>): void {
    const settled = operation.then(() => undefined, () => undefined);
    const operations = this.sessionUnsettled.get(sessionId) ?? new Set<Promise<void>>();
    operations.add(settled);
    this.sessionUnsettled.set(sessionId, operations);
    void settled.finally(() => {
      operations.delete(settled);
      if (operations.size === 0) this.sessionUnsettled.delete(sessionId);
    });
    for (const key of keys) {
      const previous = this.unsettled.get(key);
      const combined = previous ? Promise.all([previous, settled]).then(() => undefined) : settled;
      this.unsettled.set(key, combined);
      void combined.finally(() => { if (this.unsettled.get(key) === combined) this.unsettled.delete(key); });
    }
  }

  private async gitState(session: RuntimeSession, signal: AbortSignal): Promise<Map<string, string> | null> {
    const entries = await gitPorcelain(session.workspacePath, signal).then((item) => item.exitCode === 0 ? porcelainEntries(item.stdout) : null, () => null);
    if (!entries) return null;
    await Promise.all([...entries].map(async ([file, status]) => {
      entries.set(file, `${status}:${await fileFingerprint(session.workspacePath, file)}`);
    }));
    return entries;
  }

  private async approval(
    session: RuntimeSession,
    descriptor: ToolDescriptor,
    requestId: string,
    modelTurn: ActiveModelTurn,
    signal: AbortSignal
  ): Promise<"allow" | "deny" | "always_allow"> {
    if (descriptor.approval === "deny" || this.options.permissionMode === "deny") return "deny";
    const effectGrant = descriptor.possibleEffects.slice().sort().join("\0");
    if (descriptor.approval === "auto" || this.options.permissionMode === "auto" || session.alwaysAllowedEffects.has(effectGrant)) return "allow";
    let resolve!: (value: "allow" | "deny" | "always_allow") => void;
    const pending = new Promise<"allow" | "deny" | "always_allow">((accept) => { resolve = accept; });
    session.approvals.set(requestId, { effects: descriptor.possibleEffects, resolve });
    await this.options.emit(session, "tool.approval_requested", "runtime", {
      requestId,
      callId: requestId,
      toolName: descriptor.name,
      effects: descriptor.possibleEffects,
      reason: `Effects: ${descriptor.possibleEffects.join(", ")}`,
      ...turnPayload(modelTurn)
    });
    await this.options.emit(session, "run.suspended", "runtime", {
      requestId, callId: requestId, message: `Approval required for ${descriptor.name}.`, ...turnPayload(modelTurn)
    });
    try {
      return await abortable(pending, signal);
    } catch (error) {
      session.approvals.delete(requestId);
      await this.options.emit(session, "tool.approval_resolved", "runtime", {
        requestId,
        callId: requestId,
        decision: steeringRestart(signal) ? "superseded" : "cancelled",
        ...turnPayload(modelTurn)
      });
      throw error;
    }
  }

  private async emitReceipt(session: RuntimeSession, receipt: ToolReceipt, modelTurn: ActiveModelTurn): Promise<void> {
    const name = session.state.pendingTools.find((item) => item.request.callId === receipt.callId
      && item.modelTurn.turnId === modelTurn.turnId
      && item.modelTurn.effectRevision === modelTurn.effectRevision)?.request.name ?? "tool";
    await this.options.emit(session, receipt.ok ? "tool.completed" : "tool.failed", "tool", {
      ...receipt, name, ...turnPayload(modelTurn)
    });
  }

}
