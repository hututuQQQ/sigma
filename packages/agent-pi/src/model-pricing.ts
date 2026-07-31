import type { Api, Model } from "@earendil-works/pi-ai";

export interface PiModelPricingTier {
  inputTokensAbove: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion?: number;
}

export interface PiModelPricing {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion?: number;
  effectiveAt: string;
  tiers?: readonly PiModelPricingTier[];
}

export function hasKnownPricing(model: Model<Api>): boolean {
  return model.cost.input > 0
    || model.cost.output > 0
    || model.cost.cacheRead > 0
    || model.cost.cacheWrite > 0
    || (model.cost.tiers ?? []).some((tier) =>
      tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0);
}

function microUsdPerMillion(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000));
}

export function piModelPricing(
  model: Model<Api>,
  effectiveAt: string
): PiModelPricing | undefined {
  if (!hasKnownPricing(model)) return undefined;
  return {
    inputMicroUsdPerMillion: microUsdPerMillion(model.cost.input),
    outputMicroUsdPerMillion: microUsdPerMillion(model.cost.output),
    cacheReadMicroUsdPerMillion: microUsdPerMillion(model.cost.cacheRead),
    cacheWriteMicroUsdPerMillion: microUsdPerMillion(model.cost.cacheWrite),
    effectiveAt,
    ...((model.cost.tiers?.length ?? 0) > 0 ? {
      tiers: model.cost.tiers!.map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove,
        inputMicroUsdPerMillion: microUsdPerMillion(tier.input),
        outputMicroUsdPerMillion: microUsdPerMillion(tier.output),
        cacheReadMicroUsdPerMillion: microUsdPerMillion(tier.cacheRead),
        cacheWriteMicroUsdPerMillion: microUsdPerMillion(tier.cacheWrite)
      }))
    } : {})
  };
}
