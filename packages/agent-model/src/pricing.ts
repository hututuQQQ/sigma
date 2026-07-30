import type { ModelPricing } from "./catalog.js";

export type ModelPricingRates = Pick<
  ModelPricing,
  | "inputMicroUsdPerMillion"
  | "outputMicroUsdPerMillion"
  | "cacheReadMicroUsdPerMillion"
  | "cacheWriteMicroUsdPerMillion"
>;

/** Pi pricing tiers apply one request-wide rate after total input crosses a threshold. */
export function modelPricingRates(
  pricing: ModelPricing,
  inputTokens: number
): ModelPricingRates {
  let rates: ModelPricingRates = pricing;
  let matchedThreshold = -1;
  for (const tier of pricing.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  return rates;
}
