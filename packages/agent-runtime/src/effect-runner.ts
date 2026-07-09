import type {
  AgentEventEnvelope,
  AgentEventType,
  ContextAuthority,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
  ModelToolDefinition,
  RunOutcome,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import { decide, type KernelEffect } from "agent-kernel";
import { loadNestedInstructions, RepositoryContextProvider } from "agent-context";
import { gitPorcelain } from "agent-platform";
import { isToolAllowed, ResourceLockManager } from "agent-tools";
import {
  abortable, completionFailure, failed, fileFingerprint, lockKeys, mergeDelta, modelTools,
  porcelainEntries, providerSizedPlan, requestTargets, requiresInstructionReplan, steeringRestart,
  workspaceDelta, writeScopeFailure
} from "./effect-helpers.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

type Emit = (
  session: RuntimeSession,
  type: AgentEventType,
  authority: Exclude<ContextAuthority, "external_verifier">,
  value: unknown
) => Promise<AgentEventEnvelope>;

export interface EffectRunnerOptions {
  runtime: RuntimeOptions;
  maxParallelTools: number;
  permissionMode: "ask" | "auto" | "deny";
  outputReserveTokens: number;
  emit: Emit;
  finish(session: RuntimeSession, outcome: RunOutcome): Promise<void>;
  createArtifact(sessionId: string, content: string): Promise<string>;
}

export class EffectRunner {
  private readonly locks = new ResourceLockManager();
  private readonly repositoryContext = new RepositoryContextProvider();
  private readonly unsettled = new Map<string, Promise<void>>();

  constructor(private readonly options: EffectRunnerOptions) {}

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
        await this.options.finish(session, outcome);
        return;
      }
      if (effects.some((effect) => effect.type === "publish_outcome")) return;
      if (effects.some((effect) => effect.type === "request_model")) {
        await this.requestModel(session, signal);
        continue;
      }
      const tools = effects.filter((effect): effect is Extract<KernelEffect, { type: "execute_tool" }> => effect.type === "execute_tool");
      if (tools.length > 0) {
        await this.executeTools(session, tools.map((effect) => ({ id: effect.request.callId, name: effect.request.name, arguments: effect.request.arguments })), signal);
        continue;
      }
      return;
    }
    throw signal.reason ?? new Error("Run cancelled.");
  }

  private async requestModel(session: RuntimeSession, signal: AbortSignal): Promise<void> {
    const turnController = new AbortController();
    session.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    const turnId = ++session.modelTurn;
    try {
      await this.requestModelAttempt(session, turnId, turnSignal);
    } catch (error) {
      if (steeringRestart(turnSignal)) {
        await this.options.emit(session, "diagnostic", "runtime", { kind: "steering.restart", turnId });
        return;
      }
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code : "model_error";
      await this.options.emit(session, "model.failed", "runtime", {
        turnId,
        code,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async requestModelAttempt(session: RuntimeSession, turnId: number, turnSignal: AbortSignal): Promise<void> {
    const descriptors = this.options.runtime.tools.descriptors().filter((item) => isToolAllowed(item, session.mode));
    const tools = modelTools(descriptors);
    const query = [...session.state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const dynamic = await this.repositoryContext.collect(session.workspacePath, query, turnSignal);
    const plan = await providerSizedPlan(this.options.runtime.gateway, {
      system: session.contextItems,
      history: session.state.messages,
      dynamic,
      tools,
      outputReserveTokens: this.options.outputReserveTokens
    });
    if (plan.summary && !session.loadedContextIds.has(plan.summary.id)) {
      session.loadedContextIds.add(plan.summary.id);
      await this.options.emit(session, "context.compacted", "runtime", {
        item: plan.summary,
        omittedHistoryTurns: plan.omittedHistoryTurns
      });
    }
    turnSignal.throwIfAborted();
    await this.options.emit(session, "model.started", "runtime", {
      provider: this.options.runtime.gateway.provider,
      model: this.options.runtime.gateway.model,
      turnId,
      contextBudget: plan.budget
    });
    const response = await this.streamModelResponse(session, turnId, plan.messages, tools, turnSignal);
    turnSignal.throwIfAborted();
    await this.options.emit(session, "model.completed", "runtime", {
      model: this.options.runtime.gateway.model,
      turnId,
      text: response.message.content,
      finishReason: response.finishReason,
      message: response.message,
      toolCalls: response.message.toolCalls ?? []
    });
    if (response.finishReason === "length") this.addContinuationContext(session);
  }

  private async streamModelResponse(
    session: RuntimeSession,
    turnId: number,
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
    signal: AbortSignal
  ): Promise<ModelResponse> {
    let response: ModelResponse | undefined;
    let contentDelta = "";
    let reasoningDelta = "";
    let lastFlush = Date.now();
    const flush = async (): Promise<void> => {
      if (contentDelta) {
        const value = contentDelta;
        contentDelta = "";
        await this.options.emit(session, "model.delta", "runtime", { turnId, delta: value });
      }
      if (reasoningDelta) {
        const value = reasoningDelta;
        reasoningDelta = "";
        await this.options.emit(session, "model.reasoning_delta", "runtime", { turnId, delta: value });
      }
      lastFlush = Date.now();
    };
    for await (const event of this.options.runtime.gateway.stream({ messages, tools, signal })) {
      if (signal.aborted) throw signal.reason;
      if (event.type === "content") contentDelta += event.delta;
      else if (event.type === "reasoning") reasoningDelta += event.delta;
      else if (event.type === "done") response = event.response;
      if (Date.now() - lastFlush >= 33) await flush();
    }
    signal.throwIfAborted();
    await flush();
    if (!response) throw new Error("Model stream ended without a final response.");
    return response;
  }

  private addContinuationContext(session: RuntimeSession): void {
    session.contextItems.push({
      id: `runtime:continue:${session.seq}`,
      authority: "runtime",
      provenance: "model finish reason",
      content: "The previous response reached its output limit. Continue from the exact stopping point without repeating completed work.",
      tokenCount: 24,
      priority: 950
    });
  }

  private async executeTools(session: RuntimeSession, calls: ModelToolCall[], signal: AbortSignal): Promise<void> {
    const turnController = session.turnController ?? new AbortController();
    session.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    if (steeringRestart(turnSignal)) return;
    try {
      let loadedInstructions = false;
      for (const call of calls) {
        const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
        if (descriptor && await this.loadInstructions(session, call, descriptor)) loadedInstructions = true;
      }
      const pending = [...calls];
      while (pending.length > 0) {
        if (steeringRestart(turnSignal)) return;
        const batch = pending.splice(0, this.options.maxParallelTools);
        await Promise.all(batch.map(async (call) => {
          const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
          if (loadedInstructions && descriptor && requiresInstructionReplan(descriptor)) {
            const startedAt = new Date().toISOString();
            await this.options.emit(session, "tool.requested", "runtime", { callId: call.id, name: call.name, arguments: call.arguments });
            await this.emitReceipt(session, failed(
              call,
              startedAt,
              "New nested project instructions were loaded. Re-evaluate the request and propose a new tool call that follows them.",
              "nested_instructions_require_replan"
            ));
            return;
          }
          const receipt = await this.executeTool(session, call, turnSignal);
          await this.emitReceipt(session, receipt);
        }));
      }
    } finally {
      if (session.turnController === turnController) session.turnController = null;
    }
  }

  private async executeTool(session: RuntimeSession, call: ModelToolCall, signal: AbortSignal): Promise<ToolReceipt> {
    const startedAt = new Date().toISOString();
    const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
    if (!descriptor) return failed(call, startedAt, `Unknown tool '${call.name}'.`, "unknown_tool");
    await this.options.emit(session, "tool.requested", "runtime", { callId: call.id, name: call.name, arguments: call.arguments });
    const cached = session.state.receipts.find((item) => item.callId === call.id);
    if (cached && descriptor.idempotent) return { ...cached, diagnostics: [...cached.diagnostics, "reused_idempotent_receipt"], completedAt: new Date().toISOString() };
    if (!isToolAllowed(descriptor, session.mode)) return failed(call, startedAt, `Tool '${call.name}' is not allowed in ${session.mode} mode.`, "mode_denied");
    const scopeError = writeScopeFailure(session, call, descriptor, startedAt);
    if (scopeError) return scopeError;
    const completionError = completionFailure(session, call, descriptor, startedAt);
    if (completionError) return completionError;
    try {
      const restored = session.state.pendingTools.find((item) => item.request.callId === call.id)?.approval;
      const decision = restored === "allowed" ? "allow" : await this.approval(session, descriptor, call.id, signal);
      if (decision === "deny") return failed(call, startedAt, "Tool request denied.", "permission_denied");
      const keys = lockKeys(session, descriptor);
      await this.awaitSettled(keys, signal);
      return await this.locks.withLocks(keys, async () => await this.executeLocked(session, call, descriptor, signal, keys));
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
    descriptor: ToolDescriptor,
    signal: AbortSignal,
    resourceKeys: string[]
  ): Promise<ToolReceipt> {
    await this.options.emit(session, "tool.started", "runtime", { callId: call.id, name: call.name });
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
        progress: async (update) => { heartbeat(); await this.options.emit(session, "tool.progress", "tool", { callId: call.id, name: call.name, ...update }); },
        createArtifact: async (artifact) => await this.options.createArtifact(session.sessionId, artifact.content)
      });
      let receipt: ToolReceipt;
      try {
        receipt = await abortable(execution, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) this.quarantine(resourceKeys, execution);
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

  private quarantine(keys: string[], operation: Promise<unknown>): void {
    const settled = operation.then(() => undefined, () => undefined);
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
      reason: `Effects: ${descriptor.possibleEffects.join(", ")}`
    });
    await this.options.emit(session, "run.suspended", "runtime", { requestId, message: `Approval required for ${descriptor.name}.` });
    try {
      return await abortable(pending, signal);
    } catch (error) {
      session.approvals.delete(requestId);
      await this.options.emit(session, "tool.approval_resolved", "runtime", {
        requestId,
        callId: requestId,
        decision: steeringRestart(signal) ? "superseded" : "cancelled"
      });
      throw error;
    }
  }

  private async emitReceipt(session: RuntimeSession, receipt: ToolReceipt): Promise<void> {
    const name = session.state.pendingTools.find((item) => item.request.callId === receipt.callId)?.request.name ?? "tool";
    await this.options.emit(session, receipt.ok ? "tool.completed" : "tool.failed", "tool", { ...receipt, name });
  }

}
