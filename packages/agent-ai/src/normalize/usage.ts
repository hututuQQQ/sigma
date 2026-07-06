import type { Usage } from "../types.js";

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

export function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const usage = raw as Record<string, unknown>;
  const promptTokens = numberFrom(usage.prompt_tokens) ?? numberFrom(usage.input_tokens);
  const completionTokens = numberFrom(usage.completion_tokens) ?? numberFrom(usage.output_tokens);
  const cacheTokens =
    numberFrom(usage.cache_tokens) ??
    numberFrom(usage.prompt_cache_hit_tokens) ??
    numberFrom(usage.cached_tokens) ??
    numberFrom((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  const totalTokens = numberFrom(usage.total_tokens) ?? sumNumbers(promptTokens, completionTokens);

  const normalized: Usage = {};
  if (promptTokens !== undefined) normalized.inputTokens = promptTokens;
  if (completionTokens !== undefined) normalized.outputTokens = completionTokens;
  if (cacheTokens !== undefined) normalized.cacheTokens = cacheTokens;
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
