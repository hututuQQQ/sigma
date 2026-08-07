import { canonicalJson, digest } from "./common.mjs";

export const TRACE_ATTRIBUTION_SCHEMA_VERSION = 1;
export const TRACE_ATTRIBUTION_SCHEMA_ID = "https://sigmacode.biz/schemas/trace-attribution/v1";
export const TRACE_ATTRIBUTION_VERSION = "trace-attribution-1.0.0";
export const TOKEN_ESTIMATOR = "context_plan_approximate_tokens";
export const TOKEN_PROXY = "uncached_input_plus_output_v1";

const PATH_KEY = /(?:^|_)(?:path|paths|file|files|directory|directories|root|cwd)$/iu;
const RANGE_KEY = /(?:^|_)(?:start|end|line|lines|offset|limit|range)$/iu;

export function eventRef(event) {
  return event ? { eventId: event.eventId, seq: event.seq, type: event.type } : null;
}

export function safeLabel(value, redactor = String) {
  return redactor(typeof value === "string" ? value : String(value ?? "unknown"));
}

function normalizeValue(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childKey, item]) => [childKey, normalizeValue(item, childKey)]));
  }
  if (typeof value === "string" && PATH_KEY.test(key)) return value.replace(/\\/gu, "/");
  return value;
}

export function canonicalArgumentsDigest(value, redactor = String) {
  return digest(redactor(canonicalJson(normalizeValue(value ?? {}))));
}

function scopeEntries(value, prefix = []) {
  if (Array.isArray(value)) return value.flatMap((item, index) => scopeEntries(item, [...prefix, index]));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, item]) => {
    const nested = scopeEntries(item, [...prefix, key]);
    return PATH_KEY.test(key) || RANGE_KEY.test(key)
      ? [{ key: [...prefix, key].join("."), value: normalizeValue(item, key) }, ...nested]
      : nested;
  });
}

export function readScopeDigest(value, redactor = String) {
  const entries = scopeEntries(value ?? {});
  return entries.length > 0 ? digest(redactor(canonicalJson(entries))) : null;
}

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function nativeUsageAvailable(usage) {
  if (usage?.providerReported !== true) return false;
  const input = finiteToken(usage.inputTokens);
  const output = finiteToken(usage.outputTokens);
  return input !== null && output !== null && input + output > 0;
}

function providerUsage(usage) {
  const available = nativeUsageAvailable(usage);
  const cache = finiteToken(usage?.cacheReadTokens);
  return {
    accuracy: available ? "provider_native" : "unavailable",
    inputTokens: available ? finiteToken(usage.inputTokens) : null,
    outputTokens: available ? finiteToken(usage.outputTokens) : null,
    cacheReadTokens: available && cache !== null ? cache : null,
    cacheReadAccuracy: !available || cache === null
      ? "unavailable"
      : cache > 0 ? "provider_native" : "provider_or_adapter_default_zero"
  };
}

function accountedUsage(usage, native) {
  const inputTokens = finiteToken(usage?.inputTokens);
  const outputTokens = finiteToken(usage?.outputTokens);
  const cacheReadTokens = finiteToken(usage?.cacheReadTokens);
  return {
    accuracy: native.accuracy === "provider_native" ? "provider_native" : "runtime_estimated_or_defaulted",
    inputTokens,
    outputTokens,
    cacheReadTokens
  };
}

export function tokenUsageAttribution(usage) {
  const providerReported = providerUsage(usage);
  const accounted = accountedUsage(usage, providerReported);
  const complete = [accounted.inputTokens, accounted.outputTokens, accounted.cacheReadTokens]
    .every((value) => value !== null);
  const value = complete
    ? Math.max(0, accounted.inputTokens - accounted.cacheReadTokens) + accounted.outputTokens
    : null;
  return {
    providerReported,
    accounted,
    uncachedInputPlusOutputV1: {
      name: TOKEN_PROXY,
      formula: "max(0,input_tokens-cache_read_tokens)+output_tokens",
      value,
      accuracy: providerReported.accuracy === "provider_native"
        && providerReported.cacheReadAccuracy === "provider_native"
        ? "provider_native" : value === null ? "unavailable" : "mixed_or_estimated"
    }
  };
}

export function reportWithDigest(report) {
  const reportDigest = digest(report);
  return { ...report, reportDigest };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, min: null, p50: null, p90: null, p95: null, max: null, mean: null };
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
    mean: Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length)
  };
}
