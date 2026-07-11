export type HookEvent =
  | "session_start"
  | "run_start"
  | "pre_model"
  | "post_model"
  | "pre_tool"
  | "post_tool"
  | "plan_changed"
  | "pre_complete"
  | "run_end";

interface HookBase {
  id: string;
  event: HookEvent;
  required: boolean;
  timeoutMs: number;
}

export interface CommandHook extends HookBase {
  kind: "command";
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Workspace-relative executable assets bound into customization trust. */
  trustPaths?: readonly string[];
}

export interface AgentProfileHook extends HookBase {
  kind: "agent_profile";
  profileId: string;
  prompt: string;
}

export type HookDefinition = CommandHook | AgentProfileHook;

export interface HookRunnerRequest {
  /** Runtime-only binding used by in-process runners; never supplied by hook configuration. */
  sessionId?: string;
  hook: HookDefinition;
  event: HookEvent;
  input: Readonly<Record<string, unknown>>;
  policy: {
    readOnly: true;
    network: "none";
    secrets: "stripped";
    maxOutputBytes: number;
  };
}

export interface HookRunnerResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

/** Implemented by agent-execution/runtime. This package never creates a process. */
export interface HookRunnerPort {
  run(request: HookRunnerRequest, signal: AbortSignal): Promise<HookRunnerResult>;
}

export interface HookContextAddition {
  text: string;
  provenance: { kind: "hook"; hookId: string; event: HookEvent };
}

export interface HookOutcome {
  hookId: string;
  event: HookEvent;
  status: "allowed" | "denied" | "observed" | "failed";
  required: boolean;
  durationMs: number;
  reason?: string;
}

export interface HookDispatchResult {
  allowed: boolean;
  contextAdditions: readonly HookContextAddition[];
  outcomes: readonly HookOutcome[];
}

/** Durable runtimes use this observer to record hook execution without
 * coupling the extensions package to a particular event store. */
export interface HookDispatchObserver {
  started(hook: HookDefinition, event: HookEvent): Promise<void> | void;
  settled(outcome: HookOutcome): Promise<void> | void;
}

export class HookGateError extends Error {
  readonly code = "hook_gate_denied";
  constructor(readonly outcome: HookOutcome, options?: ErrorOptions) {
    super(`Hook '${outcome.hookId}' blocked '${outcome.event}': ${outcome.reason ?? "no reason provided"}.`, options);
    this.name = "HookGateError";
  }
}

const MAX_HOOK_OUTPUT_BYTES = 1_048_576;

export class HookDispatcher {
  private readonly activeEvents = new Set<HookEvent>();

  constructor(
    private readonly hooks: readonly HookDefinition[],
    private readonly runner: HookRunnerPort,
    private readonly observer?: HookDispatchObserver
  ) {
    validateHookDefinitions(hooks);
  }

  async dispatch(
    event: HookEvent,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<HookDispatchResult> {
    if (this.activeEvents.has(event)) throw new Error(`Recursive hook event '${event}' is forbidden.`);
    this.activeEvents.add(event);
    try { return await this.runEvent(event, input, signal); } finally { this.activeEvents.delete(event); }
  }

  private async runEvent(
    event: HookEvent,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<HookDispatchResult> {
    const outcomes: HookOutcome[] = [];
    const contextAdditions: HookContextAddition[] = [];
    for (const hook of this.hooks.filter((candidate) => candidate.event === event)) {
      const result = await this.runOne(hook, event, input, signal);
      outcomes.push(result.outcome);
      contextAdditions.push(...result.contextAdditions);
      if (result.outcome.status === "denied" || (result.outcome.status === "failed" && (isGate(event) || hook.required))) {
        throw new HookGateError(result.outcome, result.error ? { cause: result.error } : undefined);
      }
    }
    return { allowed: true, contextAdditions, outcomes };
  }

  private async runOne(
    hook: HookDefinition,
    event: HookEvent,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<{ outcome: HookOutcome; contextAdditions: HookContextAddition[]; error?: unknown }> {
    await this.observer?.started(hook, event);
    let evaluated: { outcome: HookOutcome; contextAdditions: HookContextAddition[]; error?: unknown };
    try {
      const result = await runPort(this.runner, {
        hook,
        event,
        input: immutableCopy(input),
        policy: { readOnly: true, network: "none", secrets: "stripped", maxOutputBytes: MAX_HOOK_OUTPUT_BYTES }
      }, signal);
      if (!result.ok) {
        evaluated = { outcome: failedOutcome(hook, result.error, result.durationMs), contextAdditions: [] };
      } else {
        const parsed = validateHookOutput(event, result.output);
        const denied = parsed.decision === "deny";
        evaluated = {
          outcome: {
            hookId: hook.id,
            event,
            status: denied ? "denied" : isGate(event) ? "allowed" : "observed",
            required: hook.required,
            durationMs: Math.max(0, result.durationMs),
            ...(parsed.reason ? { reason: parsed.reason } : {})
          },
          contextAdditions: (parsed.context ?? []).map((text) => ({
            text,
            provenance: { kind: "hook", hookId: hook.id, event }
          }))
        };
      }
    } catch (error) {
      evaluated = { outcome: failedOutcome(hook, messageOf(error), 0), contextAdditions: [], error };
    }
    await this.observer?.settled(evaluated.outcome);
    return evaluated;
  }
}

async function runPort(
  runner: HookRunnerPort,
  request: HookRunnerRequest,
  parentSignal: AbortSignal
): Promise<HookRunnerResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`Hook '${request.hook.id}' timed out.`)), request.hook.timeoutMs);
  const signal = AbortSignal.any([parentSignal, timeout.signal]);
  const fail = (): void => rejectAbort(signal, rejectAbortPromise);
  let rejectAbortPromise: (reason?: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbortPromise = reject;
    if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
  });
  try { return await Promise.race([runner.run(request, signal), aborted]); } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", fail);
  }
}

function rejectAbort(signal: AbortSignal, reject: (reason?: unknown) => void): void {
  reject(signal.reason ?? new Error("Hook aborted."));
}

interface ParsedHookOutput {
  decision?: "allow" | "deny";
  reason?: string;
  context?: string[];
}

function validateHookOutput(event: HookEvent, value: unknown): ParsedHookOutput {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (bytes > MAX_HOOK_OUTPUT_BYTES) throw new Error("Hook output exceeds 1 MiB.");
  const output = value === undefined ? {} : objectValue(value, "hook output");
  const known = new Set(["decision", "reason", "context"]);
  const unknown = Object.keys(output).find((key) => !known.has(key));
  if (unknown) throw new Error(`Unknown hook output field '${unknown}'.`);
  const decision = output.decision === undefined ? undefined : enumValue(output.decision, ["allow", "deny"], "decision");
  if (isGate(event) && !decision) throw new Error(`Gate hook '${event}' must return an allow/deny decision.`);
  if (!isGate(event) && decision !== undefined) throw new Error(`Observer hook '${event}' cannot return a decision.`);
  if (output.context !== undefined && event !== "pre_model") throw new Error("Only pre_model hooks may add context.");
  return {
    ...(decision ? { decision } : {}),
    ...(output.reason === undefined ? {} : { reason: stringValue(output.reason, "reason") }),
    ...(output.context === undefined ? {} : { context: stringArray(output.context, "context") })
  };
}

function isGate(event: HookEvent): boolean {
  return event.startsWith("pre_");
}

function failedOutcome(hook: HookDefinition, reason: string | undefined, durationMs: number): HookOutcome {
  return {
    hookId: hook.id,
    event: hook.event,
    status: "failed",
    required: hook.required,
    durationMs: Math.max(0, durationMs),
    ...(reason ? { reason } : {})
  };
}

export function validateHookDefinitions(hooks: readonly HookDefinition[]): void {
  const ids = new Set<string>();
  for (const hook of hooks) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(hook.id)) throw new Error(`Invalid hook id '${hook.id}'.`);
    if (ids.has(hook.id)) throw new Error(`Duplicate hook id '${hook.id}'.`);
    if (!Number.isSafeInteger(hook.timeoutMs) || hook.timeoutMs < 1) throw new Error(`Hook '${hook.id}' has invalid timeoutMs.`);
    if (hook.kind === "command" && !hook.command.trim()) throw new Error(`Hook '${hook.id}' requires a command.`);
    if (hook.kind === "agent_profile" && (!hook.profileId.trim() || !hook.prompt.trim())) {
      throw new Error(`Hook '${hook.id}' requires a profile and prompt.`);
    }
    ids.add(hook.id);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Hook ${label} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Hook ${label} must be an array of non-empty strings.`);
  }
  return [...value] as string[];
}

function enumValue<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new Error(`Hook ${label} is invalid.`);
  return value as T;
}

function immutableCopy<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
