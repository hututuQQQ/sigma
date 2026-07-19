import type {
  ModelExecutionRole,
  ModelResponse
} from "agent-protocol";
import type { ContextPlan } from "agent-context";
import type { DeadlineForecast } from "./convergence-policy.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

function modelVisibleOutputTruncatedBytes(session: RuntimeSession): number {
  return session.durable.state.receipts
    .flatMap((receipt) => receipt.diagnostics)
    .reduce((total, diagnostic) => {
      const match = /^model_output_truncated:(?:stdout|stderr):(\d+)$/u.exec(diagnostic);
      return total + (match ? Number(match[1]) : 0);
    }, 0);
}

export async function emitModelContextComposition(
  emit: RuntimeEventEmitter,
  runtime: RuntimeOptions,
  session: RuntimeSession,
  plan: ContextPlan,
  forecast: DeadlineForecast
): Promise<void> {
  await emit(session, "diagnostic", "runtime", {
    kind: "context.composition",
    ...plan.budget,
    latestHistoryBlockTokens: plan.latestHistoryBlockTokens,
    omittedHistoryTurns: plan.omittedHistoryTurns,
    cacheMode: plan.cacheMode,
    historyTokenLimit: plan.historyTokenLimit,
    dynamicSuffixTokens: plan.dynamicSuffixTokens,
    modelVisibleOutputTruncatedBytes: modelVisibleOutputTruncatedBytes(session),
    reviewCount: session.durable.state.evidence.filter((item) => item.kind === "review").length,
    deadlineStage: forecast.stage,
    executionMode: runtime.runtimeEnvironment?.executionMode ?? "sandboxed"
  });
}

export async function emitResolvedModelRoute(
  emit: RuntimeEventEmitter,
  session: RuntimeSession,
  response: ModelResponse
): Promise<void> {
  const routed = response as ModelResponse & {
    routeId?: string; role?: string; modelSpecId?: string; attempt?: number; tokenizerAssetDigest?: string
  };
  if (!routed.routeId || !routed.modelSpecId) return;
  const roles: readonly ModelExecutionRole[] = [
    "orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"
  ];
  const role = roles.includes(routed.role as ModelExecutionRole)
    ? routed.role as ModelExecutionRole : "orchestrator";
  await emit(session, "model.route_resolved", "runtime", {
    role,
    routeId: routed.routeId,
    modelSpecId: routed.modelSpecId,
    attempt: (routed.attempt ?? 0) + 1,
    ...(routed.tokenizerAssetDigest ? { tokenizerAssetDigest: routed.tokenizerAssetDigest } : {})
  });
}
