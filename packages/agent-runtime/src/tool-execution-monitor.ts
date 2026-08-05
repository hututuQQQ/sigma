import type {
  ModelToolCall,
  ToolCallApproval,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import type { ActiveModelTurn } from "agent-kernel";
import { gitPorcelain } from "agent-platform";
import {
  abortable,
  fileFingerprint,
  mergeDelta,
  porcelainEntries,
  workspaceDelta
} from "./effect-helpers.js";
import { turnPayload } from "./effect-runner-helpers.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { toolRuntimeContext } from "./repository-recovery-context.js";
import { deadlineForecast } from "./convergence-policy.js";

export interface ToolExecutionMonitorOptions {
  runtime: RuntimeOptions;
  emit: RuntimeEventEmitter;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  control: RuntimeControlService;
}

/** Resolve the runtime watchdog independently from the tool/broker idle
 * deadline. The default grace prevents two equal timers racing to classify
 * the same foreground process. */
export function resolveToolIdleWatchdogMs(runtime: RuntimeOptions, descriptor: ToolDescriptor): number | undefined {
  if (runtime.toolIdleWatchdogMs === false) return undefined;
  if (runtime.toolIdleWatchdogMs !== undefined) {
    if (!Number.isSafeInteger(runtime.toolIdleWatchdogMs) || runtime.toolIdleWatchdogMs <= 0) {
      throw new RangeError("toolIdleWatchdogMs must be a positive integer or false.");
    }
    return runtime.toolIdleWatchdogMs;
  }
  if (descriptor.idleTimeoutMs === undefined) return undefined;
  const graceMs = Math.max(1_000, Math.ceil(descriptor.idleTimeoutMs * 0.25));
  return descriptor.idleTimeoutMs + graceMs;
}

function processTimeout(message: string, code: "process_deadline" | "process_idle_timeout"): Error {
  return Object.assign(new Error(message), { name: "TimeoutError", code });
}

function terminalOnlyDescriptor(descriptor: ToolDescriptor): boolean {
  const effects = [
    ...descriptor.possibleEffects,
    ...(descriptor.maximumEffects ?? descriptor.possibleEffects)
  ];
  return effects.length > 0 && effects.every((effect) =>
    effect === "outcome.propose"
      || effect === "outcome.report_blocked"
      || effect === "outcome.request_input");
}

function deadlineBoundedToolTimeoutMs(
  session: RuntimeSession,
  descriptor: ToolDescriptor
): number {
  const forecast = deadlineForecast(session);
  if (forecast.stage === "unbounded") return descriptor.timeoutMs;
  const settlementReserveMs = terminalOnlyDescriptor(descriptor)
    ? 0
    : forecast.finalizationReserveMs ?? 0;
  return Math.max(1, Math.min(
    descriptor.timeoutMs,
    Math.max(1, (forecast.remainingMs ?? 0) - settlementReserveMs)
  ));
}

function requiresToolSettlement(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) => [
    "filesystem.write", "repository.write", "process.spawn", "process.spawn.readonly",
    "destructive", "validation", "open_world"
  ].includes(effect));
}

function observesWorkspace(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) =>
    ["filesystem.write", "destructive", "validation", "open_world"].includes(effect));
}

function requiresFallbackWorkspaceObservation(
  descriptor: ToolDescriptor,
  plan: ToolCallPlan
): boolean {
  return observesWorkspace(plan)
    && descriptor.workspaceDeltaAuthority !== "structured_tool_receipt";
}

export class ToolExecutionMonitor {
  private readonly unsettled = new Map<string, Promise<void>>();
  private readonly sessionUnsettled = new Map<string, Set<Promise<void>>>();

  constructor(private readonly options: ToolExecutionMonitorOptions) {}

  async waitForQuiescence(sessionId: string, signal?: AbortSignal): Promise<void> {
    while (this.sessionUnsettled.get(sessionId)?.size) {
      const pending = Promise.all([...this.sessionUnsettled.get(sessionId)!]).then(() => undefined);
      await (signal ? abortable(pending, signal) : pending);
    }
  }

  async awaitSettled(keys: string[], signal: AbortSignal): Promise<void> {
    const pending = [...new Set(keys.flatMap((key) => this.unsettled.get(key) ?? []))];
    if (pending.length > 0) await abortable(Promise.all(pending).then(() => undefined), signal);
  }

  async execute(
    session: RuntimeSession,
    call: ModelToolCall,
    modelTurn: ActiveModelTurn,
    descriptor: ToolDescriptor, plan: ToolCallPlan, signal: AbortSignal, resourceKeys: string[],
    approval?: ToolCallApproval
  ): Promise<ToolReceipt> {
    await this.options.emit(session, "tool.started", "runtime", {
      callId: call.id, name: call.name, ...turnPayload(modelTurn)
    });
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason ?? new Error("Run cancelled."));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = deadlineBoundedToolTimeoutMs(session, descriptor);
    const timeoutLabel = timeoutMs < descriptor.timeoutMs
      ? "deadline-bounded execution timeout"
      : "execution timeout";
    const timer = setTimeout(() => controller.abort(processTimeout(
      `Tool '${call.name}' exceeded its ${timeoutMs}ms ${timeoutLabel}.`, "process_deadline"
    )), timeoutMs);
    const idleTimeoutMs = resolveToolIdleWatchdogMs(this.options.runtime, descriptor);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = (): void => {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(processTimeout(
        `Tool '${call.name}' was idle for ${idleTimeoutMs}ms.`, "process_idle_timeout"
      )), idleTimeoutMs);
      idleTimer.unref();
    };
    heartbeat();
    try {
      const requiresSettlement = requiresToolSettlement(plan);
      const fallbackObservation = requiresFallbackWorkspaceObservation(descriptor, plan);
      const before = fallbackObservation
        ? await this.observeWorkspace(
            session, call, modelTurn, controller.signal,
            "Observing workspace state before execution."
          )
        : null;
      const execution = this.options.runtime.tools.execute({
        callId: call.id, name: call.name, arguments: call.arguments
      }, {
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        workspacePath: session.identity.workspacePath,
        runMode: session.durable.mode,
        ...toolRuntimeContext(session),
        callPlan: plan,
        ...(approval ? { approval } : {}),
        signal: controller.signal,
        heartbeat,
        progress: async (update) => {
          heartbeat();
          await this.options.emit(session, "tool.progress", "tool", {
            callId: call.id, name: call.name, ...turnPayload(modelTurn), ...update
          });
        },
        createArtifact: async (artifact) =>
          await this.options.createArtifact(session.identity.sessionId, artifact.content),
        runtimeControl: this.options.control.forSession(session)
      });
      const receipt = await this.settledReceipt(
        execution, requiresSettlement, controller, session.identity.sessionId, resourceKeys
      );
      if (!before) return receipt;
      return await this.withFallbackWorkspaceDelta(
        session, call, modelTurn, controller.signal, before, receipt
      );
    } finally {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async settledReceipt(
    execution: Promise<ToolReceipt>,
    requiresSettlement: boolean,
    controller: AbortController,
    sessionId: string,
    resourceKeys: string[]
  ): Promise<ToolReceipt> {
    try {
      // Mutation/process executors must confirm termination before checkpoint
      // recovery. Read-only plugins may be quarantined if they ignore abort.
      return requiresSettlement ? await execution : await abortable(execution, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !requiresSettlement) {
        this.quarantine(sessionId, resourceKeys, execution);
      }
      throw error;
    }
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
      void combined.finally(() => {
        if (this.unsettled.get(key) === combined) this.unsettled.delete(key);
      });
    }
  }

  private async observeWorkspace(
    session: RuntimeSession,
    call: ModelToolCall,
    modelTurn: ActiveModelTurn,
    signal: AbortSignal,
    message: string
  ): Promise<Map<string, string> | null> {
    await this.options.emit(session, "tool.progress", "tool", {
      callId: call.id,
      name: call.name,
      ...turnPayload(modelTurn),
      message
    });
    return await this.gitState(session, signal);
  }

  private async withFallbackWorkspaceDelta(
    session: RuntimeSession,
    call: ModelToolCall,
    modelTurn: ActiveModelTurn,
    signal: AbortSignal,
    before: Map<string, string>,
    receipt: ToolReceipt
  ): Promise<ToolReceipt> {
    const after = await this.observeWorkspace(
      session, call, modelTurn, signal,
      "Observing workspace changes after execution."
    );
    if (!after) return receipt;
    const observed = workspaceDelta(before, after);
    const changed = observed.added.length + observed.modified.length + observed.deleted.length > 0;
    const actualEffects = receipt.actualEffects ?? receipt.observedEffects;
    const withWrite = changed && !actualEffects.includes("filesystem.write")
      ? [...actualEffects, "filesystem.write" as const]
      : actualEffects;
    return {
      ...receipt,
      workspaceDelta: mergeDelta(receipt.workspaceDelta, observed),
      observedEffects: withWrite,
      actualEffects: withWrite
    };
  }

  private async gitState(session: RuntimeSession, signal: AbortSignal): Promise<Map<string, string> | null> {
    const execution = this.options.runtime.execution;
    if (!execution) return null;
    const entries = await gitPorcelain(session.identity.workspacePath, signal, execution)
      .then((item) => item.exitCode === 0 ? porcelainEntries(item.stdout) : null, () => null);
    if (!entries) return null;
    await Promise.all([...entries].map(async ([file, status]) => {
      entries.set(file, `${status}:${await fileFingerprint(session.identity.workspacePath, file)}`);
    }));
    return entries;
  }
}
