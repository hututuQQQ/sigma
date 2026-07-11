import { randomUUID } from "node:crypto";
import { isSecretEnvironmentKey, SecretRedactor } from "agent-execution";
import type {
  FrozenAgentProfile,
  HookEvent,
  HookRunnerPort,
  HookRunnerRequest,
  HookRunnerResult
} from "agent-extensions";
import type {
  BudgetReservation,
  ModelGateway,
  ModelRequest,
  ModelResponse
} from "agent-protocol";
import type { ModelRouteConstraints } from "agent-model";
import type { BudgetController } from "./budget-controller.js";
import {
  consumedBudget,
  failedModelUsage,
  prepareModelBudget,
  successfulModelUsage
} from "./model-accounting.js";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

export interface ModelAgentProfileHookRunnerOptions {
  session(sessionId: string): RuntimeSession;
  resolveProfile(session: RuntimeSession, profileId: string): FrozenAgentProfile | undefined;
  gateway(session: RuntimeSession, profile: FrozenAgentProfile): ModelGateway;
  budgets: BudgetController;
  emit: RuntimeEventEmitter;
  maxOutputTokens?: number;
  secretEnvironment?: NodeJS.ProcessEnv;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedResult(error: unknown, startedAt: number): HookRunnerResult {
  return { ok: false, error: messageOf(error), durationMs: Math.max(0, performance.now() - startedAt) };
}

function outputContract(event: HookRunnerRequest["event"]): string {
  if (event === "pre_model") {
    return "Return exactly one JSON object with decision='allow'|'deny', optional non-empty reason, and optional context as an array of non-empty strings.";
  }
  if (event.startsWith("pre_")) {
    return "Return exactly one JSON object with decision='allow'|'deny' and an optional non-empty reason. Do not return context.";
  }
  return "Return exactly one JSON object with an optional non-empty reason. Do not return decision or context.";
}

function messages(request: HookRunnerRequest, safeInput: Readonly<Record<string, unknown>>) {
  return [{
    role: "system" as const,
    content: [
      "You are a Sigma Code read-only policy hook.",
      "Evaluate only the supplied hook prompt, event, and redacted input.",
      "You have no tools, filesystem, process, child-agent, or network access.",
      "Never claim that you performed an external action.",
      outputContract(request.event)
    ].join(" ")
  }, {
    role: "user" as const,
    content: JSON.stringify({
      hookId: request.hook.id,
      prompt: request.hook.kind === "agent_profile" ? request.hook.prompt : "",
      event: request.event,
      input: safeInput
    })
  }];
}

function strictOutput(response: ModelResponse, maxBytes: number): Record<string, unknown> {
  if (response.finishReason !== "stop") {
    throw new Error(`Agent-profile hook model ended with '${response.finishReason}'.`);
  }
  const content = response.message.content.trim();
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error("Agent-profile hook output exceeds its byte limit.");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch (error) {
    throw new Error(`Agent-profile hook returned invalid JSON: ${messageOf(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent-profile hook output must be one JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function attempts(error: unknown): number {
  const value = (error as { attempts?: unknown })?.attempts;
  return typeof value === "number" ? Math.max(1, Math.trunc(value)) : 1;
}

interface HookReservationIdentity {
  profileId: string;
  hookId: string;
  event: HookEvent;
  required: boolean;
}

const HOOK_EVENTS = new Set<HookEvent>([
  "session_start", "run_start", "pre_model", "post_model", "pre_tool",
  "post_tool", "plan_changed", "pre_complete", "run_end"
]);

function reservationOwner(
  profileId: string,
  request: HookRunnerRequest
): string {
  return [
    "hook-model",
    profileId,
    request.hook.id,
    request.event,
    request.hook.required ? "required" : "optional",
    randomUUID()
  ].join(":");
}

function hookReservation(reservation: BudgetReservation): HookReservationIdentity | undefined {
  const [prefix, profileId, hookId, event, policy] = reservation.ownerId.split(":");
  if (prefix !== "hook-model" || !profileId || !hookId || !HOOK_EVENTS.has(event as HookEvent)
    || (policy !== "required" && policy !== "optional")) return undefined;
  return { profileId, hookId, event: event as HookEvent, required: policy === "required" };
}

async function preflightMinimumBudget(
  session: RuntimeSession,
  emit: RuntimeEventEmitter
): Promise<string | undefined> {
  const minimums = { inputTokens: 1, outputTokens: 1, modelTurns: 1 } as const;
  for (const [dimension, requested] of Object.entries(minimums) as Array<
    [keyof typeof minimums, number]
  >) {
    const available = session.state.budget.limits[dimension]
      - session.state.budget.consumed[dimension]
      - session.state.budget.reserved[dimension];
    if (available >= requested) continue;
    await emit(session, "budget.exhausted", "runtime", { dimension, requested, available });
    return `Budget '${dimension}' requires ${requested}, but only ${available} remains.`;
  }
  return undefined;
}

async function complete(
  gateway: ModelGateway,
  request: ModelRequest,
  constraints: ModelRouteConstraints | undefined
): Promise<ModelResponse> {
  const constrained = gateway as ModelGateway & {
    completeWithConstraints?(input: ModelRequest, route: ModelRouteConstraints): Promise<ModelResponse>;
  };
  return constraints && constrained.completeWithConstraints
    ? await constrained.completeWithConstraints(request, constraints)
    : await gateway.complete(request);
}

/** Production, zero-tool Agent Profile hook execution with shared durable accounting. */
export class ModelAgentProfileHookRunner implements HookRunnerPort {
  private readonly redactor: SecretRedactor;

  constructor(private readonly options: ModelAgentProfileHookRunnerOptions) {
    this.redactor = new SecretRedactor(Object.fromEntries(
      Object.entries(options.secretEnvironment ?? process.env).filter(([name]) => isSecretEnvironmentKey(name))
    ));
  }

  async recoverInterrupted(session: RuntimeSession): Promise<number> {
    let recovered = 0;
    for (const reservation of session.state.budget.reservations) {
      const identity = hookReservation(reservation);
      if (!identity || reservation.status === "released"
        || session.state.usage.some((item) => item.requestId === reservation.ownerId)) continue;
      const consumed = reservation.status === "reserved" ? reservation.requested : reservation.consumed;
      if (reservation.status === "reserved") {
        await this.options.budgets.commit(session, reservation.reservationId, reservation.requested);
      }
      const profile = this.options.resolveProfile(session, identity.profileId);
      const gateway = profile ? this.options.gateway(session, profile) : session.gateway;
      const prepared = {
        estimatedInputTokens: Math.max(1, consumed.inputTokens),
        reserved: consumed,
        reservedAttempts: Math.max(1, consumed.modelTurns)
      };
      const usage = {
        ...failedModelUsage(
          session,
          gateway,
          reservation.ownerId,
          prepared,
          0,
          "planner",
          Math.max(1, consumed.modelTurns)
        ),
        usageId: `${reservation.ownerId}:usage`,
        requestId: reservation.ownerId,
        inputTokens: consumed.inputTokens,
        outputTokens: consumed.outputTokens,
        costMicroUsd: consumed.costMicroUsd,
        providerReported: false
      };
      await this.options.emit(session, "usage.recorded", "runtime", usage);
      const reason = "Agent-profile hook model result was lost during runtime recovery; its full reservation was charged and marked failed before any new hook dispatch.";
      await this.options.emit(session, "hook.failed", "runtime", {
        hookId: identity.hookId,
        event: identity.event,
        required: identity.required,
        durationMs: 0,
        outcome: {
          hookId: identity.hookId,
          event: identity.event,
          status: "failed",
          required: identity.required,
          durationMs: 0,
          reason
        }
      });
      await this.options.emit(session, "diagnostic", "runtime", {
        kind: "hook_model_recovered",
        hookId: identity.hookId,
        event: identity.event,
        requestId: reservation.ownerId,
        reservationId: reservation.reservationId,
        policy: "commit_full_no_replay"
      });
      recovered += 1;
    }
    return recovered;
  }

  async run(request: HookRunnerRequest, signal: AbortSignal): Promise<HookRunnerResult> {
    const startedAt = performance.now();
    if (request.hook.kind !== "agent_profile") {
      return { ok: false, error: "ModelAgentProfileHookRunner only accepts agent_profile hooks.", durationMs: 0 };
    }
    if (!request.sessionId) {
      return { ok: false, error: "Agent-profile hook has no bound runtime session.", durationMs: 0 };
    }
    const session = this.options.session(request.sessionId);
    const profile = this.options.resolveProfile(session, request.hook.profileId);
    if (!profile) {
      return {
        ok: false,
        error: `Agent-profile hook references unknown frozen profile '${request.hook.profileId}'.`,
        durationMs: Math.max(0, performance.now() - startedAt)
      };
    }
    return await this.runResolved(request, signal, session, profile, startedAt);
  }

  private async runResolved(
    request: HookRunnerRequest,
    signal: AbortSignal,
    session: RuntimeSession,
    profile: FrozenAgentProfile,
    startedAt: number
  ): Promise<HookRunnerResult> {
    const gateway = this.options.gateway(session, profile);
    const exhausted = await preflightMinimumBudget(session, this.options.emit);
    if (exhausted) {
      return { ok: false, error: exhausted, durationMs: Math.max(0, performance.now() - startedAt) };
    }
    const safeInput = this.redactor.redactUnknown(request.input) as Readonly<Record<string, unknown>>;
    const hookMessages = messages(request, safeInput);
    const remainingOutputTokens = session.state.budget.limits.outputTokens
      - session.state.budget.consumed.outputTokens
      - session.state.budget.reserved.outputTokens;
    const maxOutputTokens = Math.min(
      this.options.maxOutputTokens ?? 2_048,
      gateway.capabilities.maxOutputTokens,
      Math.max(1, Math.floor(remainingOutputTokens / 1.2))
    );
    const remainingCost = session.state.budget.limits.costMicroUsd
      - session.state.budget.consumed.costMicroUsd
      - session.state.budget.reserved.costMicroUsd;
    let prepared;
    try {
      prepared = await prepareModelBudget(gateway, hookMessages, [], maxOutputTokens, remainingCost);
    } catch (error) {
      return failedResult(error, startedAt);
    }
    const requestId = reservationOwner(profile.profile.id, request);
    let reservationId: string;
    try {
      reservationId = await this.options.budgets.reserve(session, requestId, prepared.reserved);
    } catch (error) {
      return failedResult(error, startedAt);
    }
    let response: ModelResponse;
    try {
      signal.throwIfAborted();
      response = await complete(gateway, {
        messages: hookMessages,
        tools: [],
        maxOutputTokens,
        temperature: 0,
        signal
      }, prepared.routeConstraints);
    } catch (error) {
      const usage = failedModelUsage(
        session,
        gateway,
        requestId,
        prepared,
        performance.now() - startedAt,
        "planner",
        attempts(error)
      );
      await this.options.budgets.commit(session, reservationId, consumedBudget(usage, prepared));
      await this.options.emit(session, "usage.recorded", "runtime", usage);
      return failedResult(error, startedAt);
    }
    const usage = successfulModelUsage(
      session,
      gateway,
      requestId,
      { messages: hookMessages, tools: [] },
      response,
      prepared,
      performance.now() - startedAt,
      "planner"
    );
    await this.options.budgets.commit(session, reservationId, consumedBudget(usage, prepared));
    await this.options.emit(session, "usage.recorded", "runtime", usage);
    return this.outputResult(response, request.policy.maxOutputBytes, startedAt);
  }

  private outputResult(response: ModelResponse, maxOutputBytes: number, startedAt: number): HookRunnerResult {
    try {
      return {
        ok: true,
        output: strictOutput(response, maxOutputBytes),
        durationMs: Math.max(0, performance.now() - startedAt)
      };
    } catch (error) {
      return failedResult(error, startedAt);
    }
  }
}
