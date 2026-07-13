import type {
  ModelToolCall,
  ToolCallApproval,
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

export interface ToolExecutionMonitorOptions {
  runtime: RuntimeOptions;
  emit: RuntimeEventEmitter;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  control: RuntimeControlService;
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
    descriptor: ToolDescriptor, signal: AbortSignal, resourceKeys: string[],
    approval?: ToolCallApproval
  ): Promise<ToolReceipt> {
    await this.options.emit(session, "tool.started", "runtime", {
      callId: call.id, name: call.name, ...turnPayload(modelTurn)
    });
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason ?? new Error("Run cancelled."));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(
      new Error(`Tool '${call.name}' exceeded ${descriptor.timeoutMs}ms.`),
      { name: "TimeoutError" }
    )), descriptor.timeoutMs);
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
      const observes = descriptor.possibleEffects.some((effect) =>
        ["filesystem.write", "process.spawn", "destructive", "validation"].includes(effect));
      const before = observes ? await this.gitState(session, controller.signal) : null;
      const execution = this.options.runtime.tools.execute({
        callId: call.id, name: call.name, arguments: call.arguments
      }, {
        sessionId: session.sessionId,
        runId: session.runId,
        workspacePath: session.workspacePath,
        runMode: session.mode,
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
          await this.options.createArtifact(session.sessionId, artifact.content),
        runtimeControl: this.options.control.forSession(session)
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
    } finally {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", onAbort);
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

  private async gitState(session: RuntimeSession, signal: AbortSignal): Promise<Map<string, string> | null> {
    const execution = this.options.runtime.execution;
    if (!execution) return null;
    const entries = await gitPorcelain(session.workspacePath, signal, execution)
      .then((item) => item.exitCode === 0 ? porcelainEntries(item.stdout) : null, () => null);
    if (!entries) return null;
    await Promise.all([...entries].map(async ([file, status]) => {
      entries.set(file, `${status}:${await fileFingerprint(session.workspacePath, file)}`);
    }));
    return entries;
  }
}
