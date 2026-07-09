import type { ModelContextLimits } from "../types.js";

const DEFAULT_RESERVED_OUTPUT_CHARS = 16000;

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface ResolvedModelContextLimits {
  modelContextChars?: number;
  effectiveMaxMessageHistoryChars?: number;
}

export function resolveModelContextLimits(options: {
  configuredMaxMessageHistoryChars?: number;
  limits?: ModelContextLimits;
}): ResolvedModelContextLimits {
  const contextChars = finitePositive(options.limits?.inputChars ?? options.limits?.contextChars);
  const reserved = finitePositive(options.limits?.reservedOutputChars) ?? DEFAULT_RESERVED_OUTPUT_CHARS;
  const modelHistoryBudget = contextChars ? Math.max(1000, contextChars - reserved) : undefined;
  const configured = finitePositive(options.configuredMaxMessageHistoryChars);
  const effective = configured && modelHistoryBudget
    ? Math.min(configured, modelHistoryBudget)
    : configured ?? modelHistoryBudget;
  return {
    ...(contextChars ? { modelContextChars: contextChars } : {}),
    ...(effective ? { effectiveMaxMessageHistoryChars: effective } : {})
  };
}
