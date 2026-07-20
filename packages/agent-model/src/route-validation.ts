import type {
  InfrastructureFailureCategory,
  ModelRoute,
  ModelSpec
} from "./catalog.js";

const INFRASTRUCTURE_FAILURES = new Set<InfrastructureFailureCategory>([
  "rate_limit", "capacity", "network", "server", "timeout"
]);

export function uniqueById<T extends { id: string }>(
  values: readonly T[],
  label: string
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`Duplicate ${label} id '${value.id}'.`);
    result.set(value.id, value);
  }
  return result;
}

export function validateRoute(route: ModelRoute, specs: ReadonlyMap<string, ModelSpec>): void {
  if (!route.id.trim()) throw new Error("Model routes require non-empty ids.");
  if (!Number.isSafeInteger(route.maxAttempts) || route.maxAttempts < 1) {
    throw new Error(`Model route '${route.id}' requires maxAttempts >= 1.`);
  }
  if (route.candidates.length === 0) {
    throw new Error(`Model route '${route.id}' requires at least one candidate.`);
  }
  if (route.maxAttempts > route.candidates.length) {
    throw new Error(`Model route '${route.id}' cannot attempt more models than it declares.`);
  }
  const fallbacks = new Set(route.fallbackOn);
  if (fallbacks.size !== route.fallbackOn.length
    || route.fallbackOn.some((item) => !INFRASTRUCTURE_FAILURES.has(item))) {
    throw new Error(`Model route '${route.id}' contains an invalid fallback policy.`);
  }
  validateCandidates(route, specs);
}

export function validateDistinctRoutes(routes: readonly ModelRoute[]): void {
  const signatures = new Map<string, string>();
  for (const route of routes) {
    const signature = JSON.stringify({
      candidates: route.candidates,
      requiredCapabilities: sortedRecord(route.requiredCapabilities ?? {}),
      requireExactTokenizer: route.requireExactTokenizer === true,
      fallbackOn: [...route.fallbackOn].sort(),
      maxAttempts: route.maxAttempts
    });
    const previous = signatures.get(signature);
    if (previous) {
      throw new Error(`Model route '${route.id}' is only an alias of '${previous}'; reuse one route id or define distinct routing policy.`);
    }
    signatures.set(signature, route.id);
  }
}

function sortedRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function validateCandidates(route: ModelRoute, specs: ReadonlyMap<string, ModelSpec>): void {
  const seen = new Set<string>();
  for (const candidate of route.candidates) {
    if (!specs.has(candidate)) {
      throw new Error(`Model route '${route.id}' references unknown model '${candidate}'.`);
    }
    if (seen.has(candidate)) throw new Error(`Model route '${route.id}' repeats model '${candidate}'.`);
    seen.add(candidate);
  }
}

export function validateSpec(spec: ModelSpec): void {
  if (!spec.id.trim() || !spec.upstreamModel.trim() || !spec.tokenizer.id.trim()) {
    throw new Error("Model specs require non-empty ids, upstream models, and tokenizer ids.");
  }
  validateTokenizer(spec);
  validateCapabilities(spec);
  if (spec.pricing) validatePricing(spec.id, spec.pricing);
}

function validateTokenizer(spec: ModelSpec): void {
  if (spec.tokenizer.assetDigest !== undefined && !/^[a-f0-9]{64}$/u.test(spec.tokenizer.assetDigest)) {
    throw new Error(`Model spec '${spec.id}' has an invalid tokenizer asset digest.`);
  }
  if (spec.tokenizer.maxTokensPerUtf8Byte !== undefined
    && (!Number.isSafeInteger(spec.tokenizer.maxTokensPerUtf8Byte)
      || spec.tokenizer.maxTokensPerUtf8Byte < 1)) {
    throw new Error(`Model spec '${spec.id}' has an invalid tokenizer UTF-8 expansion bound.`);
  }
}

function validateCapabilities(spec: ModelSpec): void {
  const capabilities = spec.capabilities;
  if (!Number.isSafeInteger(capabilities.contextWindowTokens) || capabilities.contextWindowTokens < 1
    || !Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens < 1
    || capabilities.maxOutputTokens > capabilities.contextWindowTokens) {
    throw new Error(`Model spec '${spec.id}' has invalid token limits.`);
  }
}

function validatePricing(specId: string, pricing: NonNullable<ModelSpec["pricing"]>): void {
  for (const value of [
    pricing.inputMicroUsdPerMillion,
    pricing.outputMicroUsdPerMillion,
    pricing.cacheReadMicroUsdPerMillion,
    pricing.cacheWriteMicroUsdPerMillion ?? 0
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Model spec '${specId}' has invalid pricing.`);
    }
  }
}
