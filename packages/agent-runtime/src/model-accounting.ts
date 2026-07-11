import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  ModelGateway,
  ModelExecutionRole,
  ModelMessage,
  ModelResponse,
  ModelToolDefinition,
  UsageRecord
} from "agent-protocol";
import {
  builtinModelSpec,
  normalizeUsage,
  type ModelRouteConstraints,
  type ModelReservationEstimate,
  type ModelSpec,
  type NormalizedModelUsage
} from "agent-model";

export interface PreparedModelBudget {
  estimatedInputTokens: number;
  reserved: Partial<BudgetAmounts>;
  reservedAttempts: number;
  attemptReservations?: readonly ModelReservationEstimate[];
  spec?: ModelSpec;
  routeConstraints?: ModelRouteConstraints;
}

interface BudgetAwareGateway extends ModelGateway {
  budgetPlan(
    messages: ModelMessage[], tools: ModelToolDefinition[], maxOutputTokens: number, remainingBudgetMicroUsd: number
  ): Promise<{
    estimatedInputTokens: number;
    reservedInputTokens: number;
    reservedOutputTokens: number;
    reservedCostMicroUsd: number;
    reservedModelTurns: number;
    attemptReservations: readonly ModelReservationEstimate[];
    constraints: ModelRouteConstraints;
  }>;
  routingIdentity(): { role: ModelExecutionRole; routeId: string };
}

function budgetAware(gateway: ModelGateway): gateway is BudgetAwareGateway {
  return typeof (gateway as Partial<BudgetAwareGateway>).budgetPlan === "function"
    && typeof (gateway as Partial<BudgetAwareGateway>).routingIdentity === "function";
}

function matchingSpec(gateway: ModelGateway): ModelSpec | undefined {
  if (gateway.provider !== "deepseek" && gateway.provider !== "glm") return undefined;
  return builtinModelSpec(gateway.provider, gateway.model);
}

function maximumCost(spec: ModelSpec | undefined, inputTokens: number, outputTokens: number): number {
  if (!spec?.pricing) return 0;
  return Math.ceil((
    inputTokens * spec.pricing.inputMicroUsdPerMillion
    + outputTokens * spec.pricing.outputMicroUsdPerMillion
  ) / 1_000_000);
}

export async function prepareModelBudget(
  gateway: ModelGateway,
  messages: ModelMessage[],
  tools: ModelToolDefinition[],
  outputReserveTokens: number,
  remainingBudgetMicroUsd?: number
): Promise<PreparedModelBudget> {
  const spec = matchingSpec(gateway);
  const outputTokens = Math.min(outputReserveTokens, gateway.capabilities.maxOutputTokens);
  if (budgetAware(gateway) && remainingBudgetMicroUsd !== undefined) {
    const plan = await gateway.budgetPlan(messages, tools, outputTokens, remainingBudgetMicroUsd);
    return {
      estimatedInputTokens: Math.max(1, plan.reservedInputTokens),
      reserved: {
        inputTokens: Math.max(1, plan.reservedInputTokens),
        outputTokens: plan.reservedOutputTokens,
        costMicroUsd: plan.reservedCostMicroUsd,
        modelTurns: plan.reservedModelTurns
      },
      reservedAttempts: plan.reservedModelTurns,
      attemptReservations: plan.attemptReservations,
      routeConstraints: plan.constraints,
      ...(spec ? { spec } : {})
    };
  }
  const counted = await gateway.countTokens(messages, tools);
  const margin = spec?.tokenizer.accuracy === "exact" ? 1 : 1.2;
  const estimatedInputTokens = Math.max(1, Math.ceil(counted * margin));
  const reservedOutputTokens = Math.ceil(outputTokens * margin);
  return {
    estimatedInputTokens,
    reserved: {
      inputTokens: estimatedInputTokens,
      outputTokens: reservedOutputTokens,
      costMicroUsd: maximumCost(spec, estimatedInputTokens, reservedOutputTokens),
      modelTurns: 1
    },
    reservedAttempts: 1,
    ...(spec ? { spec } : {})
  };
}

function normalizedUsage(
  response: ModelResponse,
  request: { messages: ModelMessage[]; tools: ModelToolDefinition[] },
  prepared: PreparedModelBudget,
  latencyMs: number
): NormalizedModelUsage {
  const existing = (response as ModelResponse & { usage?: NormalizedModelUsage }).usage;
  return existing ?? normalizeUsage({
    request,
    response,
    raw: { inputTokens: response.inputTokens, outputTokens: response.outputTokens },
    pricing: prepared.spec?.pricing,
    latencyMs,
    retryAttempt: 0
  });
}

interface RoutedResponseIdentity {
  routeId?: string;
  role?: ModelExecutionRole;
  modelSpecId?: string;
  providerId?: string;
  tokenizerId?: string;
  tokenizerAccuracy?: "exact" | "approximate";
  tokenizerAssetDigest?: string;
}

function responseIdentity(response: ModelResponse | undefined): RoutedResponseIdentity {
  return (response as RoutedResponseIdentity | undefined) ?? {};
}

interface UsageIdentity {
  role: ModelExecutionRole;
  routeId: string;
  providerId: string;
  modelSpecId: string;
  tokenizerId: string;
  tokenizerAccuracy: "exact" | "approximate";
  tokenizerAssetDigest?: string;
}

function defined<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function usageIdentity(
  gateway: ModelGateway,
  response: ModelResponse | undefined,
  prepared: PreparedModelBudget,
  role: ModelExecutionRole
): UsageIdentity {
  const routed = responseIdentity(response);
  const fallback = budgetAware(gateway) ? gateway.routingIdentity() : { role, routeId: "default" };
  const specTokenizer = prepared.spec?.tokenizer;
  const tokenizerAssetDigest = defined(routed.tokenizerAssetDigest, specTokenizer?.assetDigest);
  const identity: UsageIdentity = {
    role: defined(routed.role, fallback.role),
    routeId: defined(routed.routeId, fallback.routeId),
    providerId: defined(routed.providerId, gateway.provider),
    modelSpecId: defined(routed.modelSpecId, gateway.model),
    tokenizerId: defined(routed.tokenizerId, specTokenizer?.id ?? "legacy/approximate"),
    tokenizerAccuracy: defined(routed.tokenizerAccuracy, specTokenizer?.accuracy ?? "approximate")
  };
  return tokenizerAssetDigest ? { ...identity, tokenizerAssetDigest } : identity;
}

function record(
  session: { sessionId: string; runId: string },
  gateway: ModelGateway,
  requestId: string,
  prepared: PreparedModelBudget,
  usage: NormalizedModelUsage,
  response: ModelResponse | undefined,
  role: ModelExecutionRole
): UsageRecord {
  const identity = usageIdentity(gateway, response, prepared, role);
  return {
    usageId: randomUUID(),
    requestId,
    sessionId: session.sessionId,
    runId: session.runId,
    role: identity.role,
    routeId: identity.routeId,
    providerId: identity.providerId,
    modelId: identity.modelSpecId,
    tokenizerId: identity.tokenizerId,
    tokenizerAccuracy: identity.tokenizerAccuracy,
    ...(identity.tokenizerAssetDigest ? { tokenizerAssetDigest: identity.tokenizerAssetDigest } : {}),
    providerReported: usage.providerReported,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costMicroUsd: usage.costMicroUsd ?? 0,
    latencyMs: usage.latencyMs,
    attempt: usage.retryAttempt + 1,
    occurredAt: new Date().toISOString()
  };
}

export function successfulModelUsage(
  session: { sessionId: string; runId: string },
  gateway: ModelGateway,
  requestId: string,
  request: { messages: ModelMessage[]; tools: ModelToolDefinition[] },
  response: ModelResponse,
  prepared: PreparedModelBudget,
  latencyMs: number,
  role: ModelExecutionRole = "orchestrator"
): UsageRecord {
  const usage = record(
    session,
    gateway,
    requestId,
    prepared,
    normalizedUsage(response, request, prepared, latencyMs),
    response,
    role
  );
  const priorAttempts = prepared.attemptReservations?.slice(0, Math.max(0, usage.attempt - 1)) ?? [];
  if (priorAttempts.length === 0) return usage;
  return {
    ...usage,
    inputTokens: usage.inputTokens + priorAttempts.reduce((total, item) => total + item.inputTokens, 0),
    costMicroUsd: usage.costMicroUsd + priorAttempts.reduce((total, item) => total + (item.costMicroUsd ?? 0), 0),
    providerReported: false
  };
}

export function failedModelUsage(
  session: { sessionId: string; runId: string },
  gateway: ModelGateway,
  requestId: string,
  prepared: PreparedModelBudget,
  latencyMs: number,
  role: ModelExecutionRole = "orchestrator",
  attempt = 1
): UsageRecord {
  const inputTokens = prepared.estimatedInputTokens;
  const usage = record(session, gateway, requestId, prepared, {
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerReported: false,
    costMicroUsd: prepared.spec
      ? maximumCost(prepared.spec, inputTokens, 0)
      : prepared.reserved.costMicroUsd ?? 0,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    retryAttempt: Math.max(0, attempt - 1)
  }, undefined, role);
  return prepared.attemptReservations
    ? {
        ...usage,
        costMicroUsd: prepared.attemptReservations.reduce((total, item) => total + (item.costMicroUsd ?? 0), 0)
      }
    : usage;
}

export function consumedBudget(
  usage: UsageRecord,
  prepared?: Pick<PreparedModelBudget, "reservedAttempts">
): Partial<BudgetAmounts> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicroUsd: usage.costMicroUsd,
    modelTurns: Math.min(
      Math.max(1, usage.attempt),
      Math.max(1, prepared?.reservedAttempts ?? usage.attempt)
    )
  };
}
