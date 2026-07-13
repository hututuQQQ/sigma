import { AsyncLocalStorage } from "node:async_hooks";
import type {
  FrozenSessionHook,
  HookDefinition,
  HookDispatchResult,
  HookEvent,
  HookOutcome,
  HookRunnerPort
} from "agent-extensions";
import { HookDispatcher } from "agent-extensions";
import { verifyFrozenWorkspaceHookTrust } from "agent-extensions";
import type { ContextItem } from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

export interface RuntimeHookCoordinatorOptions {
  definitions: readonly HookDefinition[];
  runner: HookRunnerPort;
  agentProfileRunner?: HookRunnerPort;
  materializeWorkspaceHook?(
    session: RuntimeSession,
    hook: FrozenSessionHook
  ): Promise<{ definition: HookDefinition; cleanup(): Promise<void> }>;
  emit: RuntimeEventEmitter;
}

export interface RuntimeHookDispatchResult extends HookDispatchResult {
  contextItems: readonly ContextItem[];
}

export class RuntimeHookCoordinator {
  private readonly dispatchers = new Map<string, HookDispatcher>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeDispatches = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly definitionsById: ReadonlyMap<string, HookDefinition>;

  constructor(private readonly options: RuntimeHookCoordinatorOptions) {
    this.definitionsById = new Map(options.definitions.map((hook) => [hook.id, hook]));
  }

  has(session: RuntimeSession, event: HookEvent): boolean {
    return this.definitions(session).some((hook) => hook.event === event);
  }

  async dispatch(
    session: RuntimeSession,
    event: HookEvent,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<RuntimeHookDispatchResult> {
    if (!this.has(session, event)) return { allowed: true, contextAdditions: [], contextItems: [], outcomes: [] };
    const key = `${session.identity.sessionId}:${event}`;
    if (this.activeDispatches.getStore()?.has(key)) {
      throw new Error(`Recursive hook event '${event}' is forbidden.`);
    }
    const previous = this.queues.get(key) ?? Promise.resolve();
    let resolveResult!: (value: RuntimeHookDispatchResult) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<RuntimeHookDispatchResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const current = previous.catch(() => undefined).then(async () => {
      try {
        const active = new Set(this.activeDispatches.getStore() ?? []);
        active.add(key);
        resolveResult(await this.activeDispatches.run(active, async () =>
          await this.dispatchNow(session, event, input, signal)));
      } catch (error) {
        rejectResult(error);
      }
    });
    this.queues.set(key, current);
    void current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
    return await result;
  }

  private dispatcher(session: RuntimeSession): HookDispatcher {
    const existing = this.dispatchers.get(session.identity.sessionId);
    if (existing) return existing;
    const runner: HookRunnerPort = {
      run: async (request, signal) => {
        const frozen = session.durable.frozenCustomization?.hooks.find((item) => item.id === request.hook.id);
        let prepared: { definition: HookDefinition; cleanup(): Promise<void> } | undefined;
        if (frozen) {
          verifyFrozenWorkspaceHookTrust(session.identity.workspacePath, frozen);
          if (frozen.source === "workspace" && frozen.definition.kind === "command") {
            if (!this.options.materializeWorkspaceHook) {
              throw new Error(`Frozen workspace hook '${frozen.id}' has no identity-bound execution materializer.`);
            }
            prepared = await this.options.materializeWorkspaceHook(session, frozen);
          }
        }
        try {
          return await (
            request.hook.kind === "agent_profile" && this.options.agentProfileRunner
              ? this.options.agentProfileRunner
              : this.options.runner
          ).run({
            ...request,
            hook: prepared?.definition ?? request.hook,
            sessionId: session.identity.sessionId
          }, signal);
        } finally {
          await prepared?.cleanup();
        }
      }
    };
    const dispatcher = new HookDispatcher(this.definitions(session), runner, {
      started: async (hook, event) => {
        await this.options.emit(session, "hook.started", "runtime", {
          hookId: hook.id, event, required: hook.required, kind: hook.kind
        });
      },
      settled: async (outcome) => await this.recordOutcome(session, outcome)
    });
    this.dispatchers.set(session.identity.sessionId, dispatcher);
    return dispatcher;
  }

  private definitions(session: RuntimeSession): readonly HookDefinition[] {
    if (session.durable.frozenCustomization) {
      return session.durable.frozenCustomization.hooks.map((item) => item.definition);
    }
    if (!session.services.profile) return this.options.definitions;
    return session.services.profile.profile.hooks.map((id) => {
      const hook = this.definitionsById.get(id);
      if (!hook) throw new Error(`Frozen Agent Profile hook '${id}' is unavailable.`);
      return hook;
    });
  }

  private async dispatchNow(
    session: RuntimeSession,
    event: HookEvent,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<RuntimeHookDispatchResult> {
    const result = await this.dispatcher(session).dispatch(event, input, signal);
    if (result.contextAdditions.length === 0) return { ...result, contextItems: [] };
    const items: ContextItem[] = result.contextAdditions.map((addition, index) => ({
      id: `hook:${session.durable.runId}:${event}:${addition.provenance.hookId}:${session.durable.seq}:${index}`,
      authority: "runtime",
      provenance: `hook:${addition.provenance.hookId}:${addition.provenance.event}`,
      content: addition.text,
      tokenCount: Math.max(1, Math.ceil(addition.text.length / 4)),
      priority: 900
    }));
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "hook_context_added",
      event,
      items
    });
    return { ...result, contextItems: items };
  }

  private async recordOutcome(session: RuntimeSession, outcome: HookOutcome): Promise<void> {
    await this.options.emit(session, outcome.status === "failed" ? "hook.failed" : "hook.completed", "runtime", {
      hookId: outcome.hookId,
      event: outcome.event,
      required: outcome.required,
      durationMs: outcome.durationMs,
      outcome
    });
  }
}
