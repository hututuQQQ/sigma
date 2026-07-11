import type { ModelRequest, ModelResponse, ModelResponseUsage, UsageRecord } from "agent-protocol";
import type { ModelPricing, ModelRole, ModelSpec, TokenizerMetadata } from "./catalog.js";

export type NormalizedModelUsage = ModelResponseUsage;

export interface NormalizedModelResponse extends ModelResponse {
  inputTokens: number;
  outputTokens: number;
  usage: NormalizedModelUsage;
}

export type UnnormalizedModelResponse = Omit<ModelResponse, "usage"> & {
  usage?: NormalizedModelUsage;
};

export interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageRecordIdentity {
  usageId: string;
  requestId: string;
  sessionId: string;
  runId: string;
  role: ModelRole;
  routeId: string;
  providerId: string;
  modelId: string;
  tokenizer: TokenizerMetadata;
  occurredAt: string;
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value : undefined;
}

export function approximateTokenCount(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value ?? "");
  let tokens = 0;
  let latinBytes = 0;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) tokens += 1;
    else latinBytes += Buffer.byteLength(character, "utf8");
  }
  return tokens + Math.ceil(latinBytes / 4);
}

export function estimatedRequestTokens(request: Pick<ModelRequest, "messages" | "tools">): number {
  return approximateTokenCount({ messages: request.messages, tools: request.tools ?? [] });
}

export function estimatedResponseTokens(response: Pick<UnnormalizedModelResponse, "message">): number {
  return approximateTokenCount({
    content: response.message.content,
    reasoning: response.message.reasoningContent ?? "",
    toolCalls: response.message.toolCalls ?? []
  });
}

export function usageCostMicroUsd(usage: Omit<NormalizedModelUsage, "costMicroUsd">, pricing?: ModelPricing): number | null {
  if (!pricing) return null;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const numerator =
    uncachedInput * pricing.inputMicroUsdPerMillion
    + usage.outputTokens * pricing.outputMicroUsdPerMillion
    + usage.cacheReadTokens * pricing.cacheReadMicroUsdPerMillion
    + usage.cacheWriteTokens * (pricing.cacheWriteMicroUsdPerMillion ?? pricing.inputMicroUsdPerMillion);
  return Math.ceil(numerator / 1_000_000);
}

export function normalizeUsage(options: {
  request: Pick<ModelRequest, "messages" | "tools">;
  response: Pick<UnnormalizedModelResponse, "message">;
  raw?: RawUsage;
  pricing?: ModelPricing;
  latencyMs: number;
  retryAttempt: number;
}): NormalizedModelUsage {
  const rawInput = finiteTokenCount(options.raw?.inputTokens);
  const rawOutput = finiteTokenCount(options.raw?.outputTokens);
  const inputTokens = rawInput ?? estimatedRequestTokens(options.request);
  const outputTokens = rawOutput ?? estimatedResponseTokens(options.response);
  const cacheReadTokens = Math.min(inputTokens, finiteTokenCount(options.raw?.cacheReadTokens) ?? 0);
  const cacheWriteTokens = Math.min(
    Math.max(0, inputTokens - cacheReadTokens),
    finiteTokenCount(options.raw?.cacheWriteTokens) ?? 0
  );
  const base = {
    inputTokens,
    outputTokens,
    reasoningTokens: finiteTokenCount(options.raw?.reasoningTokens) ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    providerReported: rawInput !== undefined && rawOutput !== undefined,
    latencyMs: Math.max(0, Math.round(options.latencyMs)),
    retryAttempt: Math.max(0, Math.trunc(options.retryAttempt))
  };
  return { ...base, costMicroUsd: usageCostMicroUsd(base, options.pricing) };
}

export function normalizeModelResponse(options: {
  spec: Pick<ModelSpec, "pricing">;
  request: Pick<ModelRequest, "messages" | "tools">;
  response: UnnormalizedModelResponse;
  rawUsage?: RawUsage;
  latencyMs: number;
  retryAttempt: number;
}): NormalizedModelResponse {
  const existing = options.response.usage;
  const usage = existing
    ? {
        ...existing,
        costMicroUsd: existing.costMicroUsd ?? usageCostMicroUsd(existing, options.spec.pricing),
        latencyMs: Math.max(0, Math.round(options.latencyMs)),
        retryAttempt: options.retryAttempt
      }
    : normalizeUsage({
        request: options.request,
        response: options.response,
        raw: options.rawUsage ?? {
          inputTokens: options.response.inputTokens,
          outputTokens: options.response.outputTokens
        },
        pricing: options.spec.pricing,
        latencyMs: options.latencyMs,
        retryAttempt: options.retryAttempt
      });
  return { ...options.response, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usage };
}

export function toUsageRecord(usage: NormalizedModelUsage, identity: UsageRecordIdentity): UsageRecord {
  if (usage.costMicroUsd === null) {
    throw Object.assign(new Error(`Model '${identity.modelId}' has no pricing for cost accounting.`), {
      code: "model_pricing_unavailable"
    });
  }
  return {
    usageId: identity.usageId,
    requestId: identity.requestId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    role: identity.role,
    routeId: identity.routeId,
    providerId: identity.providerId,
    modelId: identity.modelId,
    tokenizerId: identity.tokenizer.id,
    tokenizerAccuracy: identity.tokenizer.accuracy,
    ...(identity.tokenizer.assetDigest ? { tokenizerAssetDigest: identity.tokenizer.assetDigest } : {}),
    providerReported: usage.providerReported,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costMicroUsd: usage.costMicroUsd,
    latencyMs: usage.latencyMs,
    attempt: usage.retryAttempt + 1,
    occurredAt: identity.occurredAt
  };
}
