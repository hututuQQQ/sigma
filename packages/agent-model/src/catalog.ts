import {
  listPiModels,
  type PiModelDescriptor,
  type PiReasoningEffort
} from "agent-pi";
import type {
  ModelBillingMode,
  ModelCapabilities,
  ModelExecutionRole
} from "agent-protocol";

export type ModelRole = ModelExecutionRole;

export type ModelFailureCategory =
  | "rate_limit"
  | "capacity"
  | "network"
  | "server"
  | "timeout"
  | "auth"
  | "configuration"
  | "content_filter"
  | "protocol";

export type InfrastructureFailureCategory = Extract<
  ModelFailureCategory,
  "rate_limit" | "capacity" | "network" | "server" | "timeout"
>;

export interface ModelFailureDiagnostics {
  provider?: string;
  model?: string;
  category?: ModelFailureCategory;
  httpStatus?: number;
  firstByteMs?: number;
  lastFrameMs?: number;
  idleDurationMs?: number;
  totalDurationMs?: number;
  doneReceived?: boolean;
  transportEnded?: boolean;
  lastEventType?: string;
  hasContent?: boolean;
  hasReasoning?: boolean;
  hasToolCall?: boolean;
  retryAttempts?: number;
  sseChunks?: number;
  sseBytes?: number;
  sseFrames?: number;
  ssePayloads?: number;
  sseTrailingBytes?: number;
  providerErrorCode?: string;
  providerEventType?: "error" | "response_failed";
  abortReason?: string;
  timeoutReason?: string;
}

export class ModelGatewayError extends Error {
  constructor(
    message: string,
    readonly category: ModelFailureCategory,
    readonly semanticDelta = false,
    readonly status?: number,
    options?: ErrorOptions,
    readonly diagnostics?: ModelFailureDiagnostics
  ) {
    super(message, options);
    this.name = "ModelGatewayError";
  }
}

export function failureDiagnostics(error: unknown): ModelFailureDiagnostics | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { diagnostics?: unknown }).diagnostics;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ModelFailureDiagnostics
    : undefined;
}

export interface TokenizerMetadata {
  id: string;
  accuracy: "exact" | "approximate";
  assetDigest?: string;
}

/** Prices are integer micro-USD per one million tokens. */
export interface ModelPricing {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion?: number;
  effectiveAt: string;
  sourceUrl?: string;
  tiers?: readonly ModelPricingTier[];
}

export interface ModelPricingTier {
  inputTokensAbove: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion?: number;
}

export interface ModelSpec {
  id: string;
  providerId: string;
  upstreamModel: string;
  billingMode: ModelBillingMode;
  billingModes?: readonly ModelBillingMode[];
  capabilities: ModelCapabilities;
  tokenizer: TokenizerMetadata;
  pricing?: ModelPricing;
  /** Public catalog rates used only for API-equivalent reporting. */
  apiEquivalentPricing?: ModelPricing;
  supportedReasoningEfforts?: readonly PiReasoningEffort[];
  defaultReasoningEffort?: PiReasoningEffort;
}

export type ModelReasoningEffort = PiReasoningEffort;

export interface ModelRoute {
  id: string;
  candidates: readonly string[];
  requiredCapabilities?: Partial<ModelCapabilities>;
  requireExactTokenizer?: boolean;
  fallbackOn: readonly InfrastructureFailureCategory[];
  maxAttempts: number;
}

const approximateTokenizer: TokenizerMetadata = {
  id: "sigma/cjk-byte",
  accuracy: "approximate",
  assetDigest: "d80956868f0d3660b3963e24f16475e592c67cebfe71dc2836cd8403e461f760"
};

function catalogBillingMode(model: PiModelDescriptor): ModelBillingMode {
  if (model.billingModes.length === 1) return model.billingModes[0]!;
  if (model.billingModes.includes("metered") && model.pricing) return "metered";
  if (model.billingModes.includes("subscription")) return "subscription";
  return "unpriced";
}

export function modelSpecsForPiCatalog(
  models: readonly PiModelDescriptor[],
  activeBillingModes: ReadonlyMap<string, ModelBillingMode> = new Map()
): readonly ModelSpec[] {
  return models.map((model): ModelSpec => {
    const configuredMode = activeBillingModes.get(model.providerId);
    const billingMode = configuredMode && model.billingModes.includes(configuredMode)
      ? configuredMode
      : catalogBillingMode(model);
    return {
      id: `${model.providerId}/${model.id}`,
      providerId: model.providerId,
      upstreamModel: model.id,
      billingMode,
      billingModes: model.billingModes,
      capabilities: model.capabilities,
      tokenizer: approximateTokenizer,
      ...(model.supportedReasoningEfforts.length > 0
        ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
        : {}),
      ...(model.defaultReasoningEffort
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
      ...(billingMode === "metered" && model.pricing
        ? { pricing: model.pricing }
        : {}),
      ...(model.pricing ? { apiEquivalentPricing: model.pricing } : {})
    };
  });
}

export const BUILTIN_MODEL_SPECS: readonly ModelSpec[] = modelSpecsForPiCatalog(
  listPiModels()
);

export function builtinModelSpec(provider: ModelSpec["providerId"], model?: string): ModelSpec | undefined {
  return BUILTIN_MODEL_SPECS.find((spec) => spec.providerId === provider && (!model || spec.upstreamModel === model));
}

export const DEFAULT_MODEL_ROUTES: readonly ModelRoute[] = [
  {
    id: "default",
    candidates: ["openai-codex/gpt-5.6-terra"],
    fallbackOn: ["rate_limit", "capacity", "network", "server", "timeout"],
    maxAttempts: 1
  }
] as const;
