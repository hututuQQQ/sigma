import type { ModelGateway } from "agent-protocol";
import { planContext, type ContextPlan, type PlanContextOptions } from "agent-context";
import { tokenizerReservationMargin } from "agent-model";

const PROACTIVE_CONTEXT_WINDOW_PERCENT = 90;

function contextOverflowError(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && (error as { code?: unknown }).code === "context_overflow");
}

export interface ContextCapacityFailure {
  source: "planner" | "router";
  routeId?: string;
  rejections: readonly { modelSpecId: string; detail: string }[];
}

/** Normalize both local planning overflow and an all-context route rejection.
 * Capability, pricing, and budget rejections must not enter compaction recovery. */
export function contextCapacityFailure(error: unknown): ContextCapacityFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    code?: unknown;
    routeId?: unknown;
    rejected?: unknown;
  };
  if (candidate.code === "context_overflow") {
    return { source: "planner", rejections: [] };
  }
  if (candidate.code !== "model_route_unavailable"
    || !Array.isArray(candidate.rejected)
    || candidate.rejected.length === 0) return undefined;
  const rejections = candidate.rejected.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rejection = item as {
      modelSpecId?: unknown;
      reason?: unknown;
      detail?: unknown;
    };
    if (rejection.reason !== "context"
      || typeof rejection.modelSpecId !== "string"
      || typeof rejection.detail !== "string") return [];
    return [{ modelSpecId: rejection.modelSpecId, detail: rejection.detail }];
  });
  if (rejections.length !== candidate.rejected.length) return undefined;
  return {
    source: "router",
    ...(typeof candidate.routeId === "string" ? { routeId: candidate.routeId } : {}),
    rejections
  };
}

export async function providerSizedPlan(
  gateway: ModelGateway,
  input: Omit<PlanContextOptions, "contextWindowTokens" | "promptCache"> & { maxInputTokens?: number }
): Promise<ContextPlan> {
  const providerLimit = gateway.capabilities.contextWindowTokens;
  const { maxInputTokens, ...contextInput } = input;
  const tokenizerMargin = tokenizerReservationMargin(gateway.capabilities.tokenizer);
  // Route admission applies the same margin to locally counted input. Planning
  // against the raw provider window creates a dead zone where a prompt fits the
  // planner but no route candidate can accept it.
  const routableInputLimit = Math.floor(
    Math.max(0, providerLimit - input.outputReserveTokens) / tokenizerMargin
  );
  const inputLimit = Math.min(routableInputLimit, maxInputTokens ?? routableInputLimit);
  // Keep replayable history below the provider's final context headroom so
  // the existing archive path activates before a very large request reaches
  // transport. Exact mandatory context still gets one full-window attempt.
  const proactiveLimit = Math.floor(
    providerLimit * PROACTIVE_CONTEXT_WINDOW_PERCENT / 100
  );
  const maximumPlanningLimit = Math.min(
    providerLimit,
    input.outputReserveTokens + inputLimit
  );
  let planningLimit = Math.min(
    maximumPlanningLimit,
    Math.max(input.outputReserveTokens + 1, proactiveLimit)
  );
  let usedMandatoryFallback = planningLimit === maximumPlanningLimit;
  while (planningLimit > input.outputReserveTokens) {
    let plan: ContextPlan;
    try {
      plan = planContext({
        ...contextInput,
        contextWindowTokens: planningLimit,
        promptCache: gateway.capabilities.promptCache
      });
    } catch (error) {
      if (!usedMandatoryFallback && contextOverflowError(error)) {
        planningLimit = maximumPlanningLimit;
        usedMandatoryFallback = true;
        continue;
      }
      throw error;
    }
    const tokens = await gateway.countTokens(plan.messages, input.tools);
    const planningInputLimit = Math.min(
      inputLimit,
      planningLimit - input.outputReserveTokens
    );
    if (tokens <= planningInputLimit
      && tokens + input.outputReserveTokens <= planningLimit) return plan;
    const ratio = Math.min(
      planningInputLimit / Math.max(1, tokens),
      planningLimit / (tokens + input.outputReserveTokens)
    );
    const next = Math.min(planningLimit - 1, Math.floor(planningLimit * ratio * 0.98));
    if (next <= input.outputReserveTokens) break;
    planningLimit = next;
  }
  throw Object.assign(new Error(
    "Provider tokenizer could not fit mandatory context and the newest user turn."
  ), { code: "context_overflow" });
}
