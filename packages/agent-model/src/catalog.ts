import type { ModelCapabilities, ModelExecutionRole } from "agent-protocol";

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
}

export interface ModelSpec {
  id: string;
  providerId: "deepseek" | "glm";
  wireProtocol: "openai_chat";
  upstreamModel: string;
  capabilities: ModelCapabilities;
  tokenizer: TokenizerMetadata;
  pricing?: ModelPricing;
}

export interface ModelRoute {
  id: string;
  candidates: readonly string[];
  requiredCapabilities?: Partial<ModelCapabilities>;
  requireExactTokenizer?: boolean;
  fallbackOn: readonly InfrastructureFailureCategory[];
  maxAttempts: number;
}

const approximateTokenizer: TokenizerMetadata = {
  id: "sigma/cjk-byte-v1",
  accuracy: "approximate",
  assetDigest: "d80956868f0d3660b3963e24f16475e592c67cebfe71dc2836cd8403e461f760"
};

export const BUILTIN_MODEL_SPECS: readonly ModelSpec[] = [
  {
    id: "deepseek/deepseek-v4-pro",
    providerId: "deepseek",
    wireProtocol: "openai_chat",
    upstreamModel: "deepseek-v4-pro",
    capabilities: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      tools: true,
      parallelTools: true,
      reasoning: true,
      structuredOutput: true,
      promptCache: true,
      tokenizer: "approximate"
    },
    tokenizer: approximateTokenizer,
    pricing: {
      inputMicroUsdPerMillion: 435_000,
      outputMicroUsdPerMillion: 870_000,
      cacheReadMicroUsdPerMillion: 3_625,
      effectiveAt: "2026-07-11",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing"
    }
  },
  {
    id: "glm/glm-5.2",
    providerId: "glm",
    wireProtocol: "openai_chat",
    upstreamModel: "glm-5.2",
    capabilities: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      tools: true,
      parallelTools: true,
      reasoning: true,
      structuredOutput: true,
      promptCache: true,
      tokenizer: "approximate"
    },
    tokenizer: approximateTokenizer,
    pricing: {
      // The provider publishes CNY prices. Sigma uses a deliberately pinned
      // accounting rate (1 CNY = 0.14 USD) so historical sessions stay stable.
      inputMicroUsdPerMillion: 1_120_000,
      outputMicroUsdPerMillion: 3_920_000,
      cacheReadMicroUsdPerMillion: 280_000,
      effectiveAt: "2026-07-11",
      sourceUrl: "https://open.bigmodel.cn/pricing"
    }
  }
] as const;

export function builtinModelSpec(provider: ModelSpec["providerId"], model?: string): ModelSpec | undefined {
  return BUILTIN_MODEL_SPECS.find((spec) => spec.providerId === provider && (!model || spec.upstreamModel === model));
}

export const DEFAULT_MODEL_ROUTES: readonly ModelRoute[] = [
  {
    id: "default",
    candidates: ["deepseek/deepseek-v4-pro", "glm/glm-5.2"],
    fallbackOn: ["rate_limit", "capacity", "network", "server", "timeout"],
    maxAttempts: 2
  }
] as const;
