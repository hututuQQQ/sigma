import type { ModelCapabilities } from "agent-protocol";

export type ConfigModelProvider = "deepseek" | "glm";
export type ConfigTokenizerAccuracy = "exact" | "approximate";
export type ConfigModelFallback = "rate_limit" | "capacity" | "network" | "server" | "timeout";

export interface ModelPricingConfigValue {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion?: number;
  effectiveAt: string;
  sourceUrl?: string;
}

export interface ModelSpecConfigValue {
  id: string;
  providerId: ConfigModelProvider;
  upstreamModel: string;
  capabilities: ModelCapabilities;
  tokenizer: { id: string; accuracy: ConfigTokenizerAccuracy; assetDigest?: string };
  pricing?: ModelPricingConfigValue;
}

export interface ModelRouteConfigValue {
  id: string;
  candidates: string[];
  requiredCapabilities?: Partial<ModelCapabilities>;
  requireExactTokenizer?: boolean;
  fallbackOn: ConfigModelFallback[];
  maxAttempts: number;
}

const SPEC_KEYS = new Set(["id", "provider", "upstream_model", "capabilities", "tokenizer", "pricing"]);
const CAPABILITY_KEYS = new Set([
  "context_window_tokens", "max_output_tokens", "tools", "parallel_tools", "reasoning",
  "structured_output", "prompt_cache", "tokenizer"
]);
const TOKENIZER_KEYS = new Set(["id", "accuracy", "asset_digest"]);
const PRICING_KEYS = new Set([
  "input_micro_usd_per_million", "output_micro_usd_per_million", "cache_read_micro_usd_per_million",
  "cache_write_micro_usd_per_million", "effective_at", "source_url"
]);
const ROUTE_KEYS = new Set([
  "id", "candidates", "required_capabilities", "require_exact_tokenizer", "fallback_on", "max_attempts"
]);

export function modelSpecsValue(raw: unknown): ModelSpecConfigValue[] {
  return values(raw, "modelSpecs").map((value, index) => modelSpec(value, `modelSpecs[${index}]`));
}

export function modelRoutesValue(raw: unknown): ModelRouteConfigValue[] {
  return values(raw, "modelRoutes").map((value, index) => modelRoute(value, `modelRoutes[${index}]`));
}

function modelSpec(raw: unknown, label: string): ModelSpecConfigValue {
  const value = object(raw, label, SPEC_KEYS);
  const capabilities = object(value.capabilities, `${label}.capabilities`, CAPABILITY_KEYS);
  const tokenizer = object(value.tokenizer, `${label}.tokenizer`, TOKENIZER_KEYS);
  const pricing = value.pricing === undefined ? undefined
    : pricingValue(object(value.pricing, `${label}.pricing`, PRICING_KEYS), `${label}.pricing`);
  return {
    id: text(value.id, `${label}.id`),
    providerId: choice(value.provider, ["deepseek", "glm"], `${label}.provider`),
    upstreamModel: text(value.upstream_model, `${label}.upstream_model`),
    capabilities: capabilitiesValue(capabilities, `${label}.capabilities`),
    tokenizer: {
      id: text(tokenizer.id, `${label}.tokenizer.id`),
      accuracy: choice(tokenizer.accuracy, ["exact", "approximate"], `${label}.tokenizer.accuracy`),
      ...(tokenizer.asset_digest === undefined ? {} : {
        assetDigest: text(tokenizer.asset_digest, `${label}.tokenizer.asset_digest`)
      })
    },
    ...(pricing ? { pricing } : {})
  };
}

function modelRoute(raw: unknown, label: string): ModelRouteConfigValue {
  const value = object(raw, label, ROUTE_KEYS);
  const required = value.required_capabilities === undefined ? undefined
    : partialCapabilities(object(value.required_capabilities, `${label}.required_capabilities`, CAPABILITY_KEYS), label);
  return {
    id: text(value.id, `${label}.id`),
    candidates: strings(value.candidates, `${label}.candidates`),
    ...(required ? { requiredCapabilities: required } : {}),
    ...(value.require_exact_tokenizer === undefined ? {} : {
      requireExactTokenizer: bool(value.require_exact_tokenizer, `${label}.require_exact_tokenizer`)
    }),
    fallbackOn: strings(value.fallback_on, `${label}.fallback_on`).map((item) => choice(
      item, ["rate_limit", "capacity", "network", "server", "timeout"], `${label}.fallback_on`
    )),
    maxAttempts: integer(value.max_attempts, `${label}.max_attempts`)
  };
}

function capabilitiesValue(value: Record<string, unknown>, label: string): ModelCapabilities {
  return {
    contextWindowTokens: integer(value.context_window_tokens, `${label}.context_window_tokens`),
    maxOutputTokens: integer(value.max_output_tokens, `${label}.max_output_tokens`),
    tools: bool(value.tools, `${label}.tools`),
    parallelTools: bool(value.parallel_tools, `${label}.parallel_tools`),
    reasoning: bool(value.reasoning, `${label}.reasoning`),
    structuredOutput: bool(value.structured_output, `${label}.structured_output`),
    promptCache: bool(value.prompt_cache, `${label}.prompt_cache`),
    tokenizer: choice(value.tokenizer, ["provider", "approximate"], `${label}.tokenizer`)
  };
}

function partialCapabilities(value: Record<string, unknown>, label: string): Partial<ModelCapabilities> {
  const result: Partial<ModelCapabilities> = {};
  const entries: Array<[string, keyof ModelCapabilities, "integer" | "boolean" | "tokenizer"]> = [
    ["context_window_tokens", "contextWindowTokens", "integer"], ["max_output_tokens", "maxOutputTokens", "integer"],
    ["tools", "tools", "boolean"], ["parallel_tools", "parallelTools", "boolean"],
    ["reasoning", "reasoning", "boolean"], ["structured_output", "structuredOutput", "boolean"],
    ["prompt_cache", "promptCache", "boolean"], ["tokenizer", "tokenizer", "tokenizer"]
  ];
  for (const [source, target, kind] of entries) {
    if (value[source] === undefined) continue;
    if (kind === "integer") (result as Record<string, unknown>)[target] = integer(value[source], `${label}.${source}`);
    else if (kind === "boolean") (result as Record<string, unknown>)[target] = bool(value[source], `${label}.${source}`);
    else result.tokenizer = choice(value[source], ["provider", "approximate"] as const, `${label}.${source}`);
  }
  return result;
}

function pricingValue(value: Record<string, unknown>, label: string): ModelPricingConfigValue {
  return {
    inputMicroUsdPerMillion: integer(value.input_micro_usd_per_million, `${label}.input_micro_usd_per_million`, true),
    outputMicroUsdPerMillion: integer(value.output_micro_usd_per_million, `${label}.output_micro_usd_per_million`, true),
    cacheReadMicroUsdPerMillion: integer(value.cache_read_micro_usd_per_million, `${label}.cache_read_micro_usd_per_million`, true),
    ...(value.cache_write_micro_usd_per_million === undefined ? {} : {
      cacheWriteMicroUsdPerMillion: integer(value.cache_write_micro_usd_per_million, `${label}.cache_write_micro_usd_per_million`, true)
    }),
    effectiveAt: text(value.effective_at, `${label}.effective_at`),
    ...(value.source_url === undefined ? {} : { sourceUrl: text(value.source_url, `${label}.source_url`) })
  };
}

function values(raw: unknown, label: string): unknown[] {
  let value = raw;
  if (typeof value === "string") value = JSON.parse(value) as unknown;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    value = value.map((item) => JSON.parse(item as string) as unknown);
  }
  if (!Array.isArray(value)) throw new Error(`Configuration '${label}' requires an array.`);
  return value;
}

function object(raw: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Configuration '${label}' requires an object.`);
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown configuration key '${label}.${unknown}'.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Configuration '${label}' requires non-empty text.`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Configuration '${label}' requires non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`Configuration '${label}' contains duplicates.`);
  return [...value] as string[];
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Configuration '${label}' requires a boolean.`);
  return value;
}

function integer(value: unknown, label: string, zero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) {
    throw new Error(`Configuration '${label}' requires a ${zero ? "non-negative" : "positive"} integer.`);
  }
  return Number(value);
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`Configuration '${label}' must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}
