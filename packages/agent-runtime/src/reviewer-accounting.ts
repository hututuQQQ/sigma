import type {
  ModelGateway,
  UsageRecord
} from "agent-protocol";
import { failedModelUsage } from "./model-accounting.js";
import type {
  PreparedReviewerCall,
  ReviewerInput
} from "./reviewer-contracts.js";

export function aggregateReviewerUsage(
  input: ReviewerInput,
  requestId: string,
  usages: readonly UsageRecord[],
  prepared: PreparedReviewerCall,
  gateway: ModelGateway
): UsageRecord {
  const first = usages[0];
  if (!first) {
    return {
      ...failedModelUsage(
        input,
        gateway,
        requestId,
        prepared.budget,
        0,
        "reviewer",
        1
      ),
      requestId
    };
  }
  const subscriptionOnly = usages.every((item) => item.billingMode === "subscription");
  const containsUnpriced = usages.some((item) => item.billingMode === "unpriced");
  const billingModes = new Set(usages.flatMap((item) =>
    item.billingMode ? [item.billingMode] : []));
  const billingMode = containsUnpriced
    ? "unpriced"
    : subscriptionOnly
    ? "subscription"
    : billingModes.size > 0
      ? "metered"
      : undefined;
  return {
    ...first,
    usageId: `${requestId}:usage`,
    requestId,
    providerReported: usages.every((item) => item.providerReported),
    inputTokens: usages.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: usages.reduce((total, item) => total + item.outputTokens, 0),
    reasoningTokens: usages.reduce((total, item) => total + item.reasoningTokens, 0),
    cacheReadTokens: usages.reduce((total, item) => total + item.cacheReadTokens, 0),
    cacheWriteTokens: usages.reduce((total, item) => total + item.cacheWriteTokens, 0),
    costMicroUsd: subscriptionOnly || containsUnpriced
      ? null
      : usages.reduce((total, item) => total + (item.costMicroUsd ?? 0), 0),
    ...(billingMode ? { billingMode } : {}),
    latencyMs: usages.reduce((total, item) => total + item.latencyMs, 0),
    attempt: usages.reduce((total, item) =>
      total + Math.max(1, item.attempt), 0),
    occurredAt: usages.at(-1)!.occurredAt
  };
}
