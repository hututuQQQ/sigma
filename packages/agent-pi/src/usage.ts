import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelResponse } from "agent-protocol";
import type { PiBillingMode } from "./models.js";

export function responseUsage(
  message: AssistantMessage,
  startedAt: number,
  billingMode: PiBillingMode,
  hasKnownCatalogPrice: boolean
): ModelResponse["usage"] {
  const apiEquivalentCostMicroUsd = hasKnownCatalogPrice
    ? Math.max(0, Math.ceil(message.usage.cost.total * 1_000_000))
    : undefined;
  return {
    inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    outputTokens: message.usage.output,
    reasoningTokens: message.usage.reasoning ?? 0,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    providerReported: true,
    costMicroUsd: billingMode === "metered" ? apiEquivalentCostMicroUsd ?? 0 : null,
    ...(apiEquivalentCostMicroUsd === undefined ? {} : { apiEquivalentCostMicroUsd }),
    billingMode,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    retryAttempt: 0
  };
}
