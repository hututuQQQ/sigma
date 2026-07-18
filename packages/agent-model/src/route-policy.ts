import type { ModelCapabilities } from "agent-protocol";
import type { ModelRoute, ModelSpec } from "./catalog.js";

export interface ModelRouteConstraints {
  requiredCapabilities?: Partial<ModelCapabilities>;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  remainingBudgetMicroUsd?: number;
  requireExactTokenizer?: boolean;
  /** Runtime budget convergence may intentionally reserve a smaller fallback
   * prefix so one final terminal request remains possible. */
  maxAttempts?: number;
}

export interface ModelRejection {
  modelSpecId: string;
  reason: "capability" | "context" | "budget" | "pricing" | "tokenizer";
  detail: string;
}

export interface ModelResolution {
  route: ModelRoute;
  candidates: readonly ModelSpec[];
  rejected: readonly ModelRejection[];
}

export function mergeRequiredCapabilities(
  left: Partial<ModelCapabilities>,
  right: Partial<ModelCapabilities>
): Partial<ModelCapabilities> {
  const result: Partial<ModelCapabilities> = {};
  assignDefined(result, "contextWindowTokens", maximum(left.contextWindowTokens, right.contextWindowTokens));
  assignDefined(result, "maxOutputTokens", maximum(left.maxOutputTokens, right.maxOutputTokens));
  assignDefined(result, "tools", requiredBoolean(left.tools, right.tools));
  assignDefined(result, "parallelTools", requiredBoolean(left.parallelTools, right.parallelTools));
  assignDefined(result, "reasoning", requiredBoolean(left.reasoning, right.reasoning));
  assignDefined(result, "structuredOutput", requiredBoolean(left.structuredOutput, right.structuredOutput));
  assignDefined(result, "promptCache", requiredBoolean(left.promptCache, right.promptCache));
  assignDefined(result, "tokenizer", right.tokenizer ?? left.tokenizer);
  return result;
}

function assignDefined<K extends keyof ModelCapabilities>(
  target: Partial<ModelCapabilities>,
  key: K,
  value: ModelCapabilities[K] | undefined
): void {
  if (value !== undefined) target[key] = value;
}

function requiredBoolean(left: boolean | undefined, right: boolean | undefined): true | undefined {
  return left === true || right === true ? true : undefined;
}

function maximum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function capabilityFailure(spec: ModelSpec, required: Partial<ModelCapabilities>): string | undefined {
  for (const [key, value] of Object.entries(required) as Array<[
    keyof ModelCapabilities,
    ModelCapabilities[keyof ModelCapabilities]
  ]>) {
    const actual = spec.capabilities[key];
    if (typeof value === "number" ? Number(actual) < value : actual !== value) {
      return `${String(key)} requires ${String(value)}, candidate has ${String(actual)}`;
    }
  }
  return undefined;
}

export const APPROXIMATE_TOKEN_RESERVATION_MARGIN = 1.5;

function tokenizerMargin(spec: ModelSpec): number {
  return spec.tokenizer.accuracy === "approximate" ? APPROXIMATE_TOKEN_RESERVATION_MARGIN : 1;
}

function contextRequirement(spec: ModelSpec, constraints: ModelRouteConstraints): number {
  const margin = tokenizerMargin(spec);
  const input = Math.ceil((constraints.estimatedInputTokens ?? 0) * margin);
  const output = Math.ceil((constraints.maxOutputTokens ?? spec.capabilities.maxOutputTokens) * margin);
  return input + output;
}

export interface ModelReservationEstimate {
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
}

export function modelReservationEstimate(
  spec: ModelSpec,
  constraints: Pick<ModelRouteConstraints, "estimatedInputTokens" | "maxOutputTokens">
): ModelReservationEstimate {
  const margin = tokenizerMargin(spec);
  const inputTokens = Math.ceil((constraints.estimatedInputTokens ?? 0) * margin);
  const outputTokens = Math.ceil((constraints.maxOutputTokens ?? spec.capabilities.maxOutputTokens) * margin);
  if (!spec.pricing) return { inputTokens, outputTokens, costMicroUsd: null };
  return {
    inputTokens,
    outputTokens,
    costMicroUsd: Math.ceil((
      inputTokens * spec.pricing.inputMicroUsdPerMillion
      + outputTokens * spec.pricing.outputMicroUsdPerMillion
    ) / 1_000_000)
  };
}

function maximumCost(spec: ModelSpec, constraints: ModelRouteConstraints): number | null {
  return modelReservationEstimate(spec, constraints).costMicroUsd;
}

function rejectionFor(
  spec: ModelSpec,
  route: ModelRoute,
  constraints: ModelRouteConstraints
): ModelRejection | undefined {
  const capability = capabilityFailure(spec, mergeRequiredCapabilities(
    route.requiredCapabilities ?? {},
    constraints.requiredCapabilities ?? {}
  ));
  if (capability) return { modelSpecId: spec.id, reason: "capability", detail: capability };
  if ((route.requireExactTokenizer || constraints.requireExactTokenizer) && spec.tokenizer.accuracy !== "exact") {
    return { modelSpecId: spec.id, reason: "tokenizer", detail: "exact tokenizer required" };
  }
  const context = contextRequirement(spec, constraints);
  if (context > spec.capabilities.contextWindowTokens
    || (constraints.maxOutputTokens ?? 0) > spec.capabilities.maxOutputTokens) {
    return { modelSpecId: spec.id, reason: "context", detail: `${context} tokens exceed candidate limits` };
  }
  if (constraints.remainingBudgetMicroUsd !== undefined) {
    const cost = maximumCost(spec, constraints);
    if (cost === null) {
      return { modelSpecId: spec.id, reason: "pricing", detail: "cost budget requires model pricing" };
    }
    if (cost > constraints.remainingBudgetMicroUsd) {
      return {
        modelSpecId: spec.id,
        reason: "budget",
        detail: `${cost} micro-USD exceeds remaining budget`
      };
    }
  }
  return undefined;
}

function withinCumulativeBudget(
  candidates: readonly ModelSpec[],
  constraints: ModelRouteConstraints,
  rejected: ModelRejection[]
): ModelSpec[] {
  const remaining = constraints.remainingBudgetMicroUsd;
  if (remaining === undefined) return [...candidates];
  let reserved = 0;
  return candidates.filter((spec) => {
    const cost = maximumCost(spec, constraints);
    if (cost === null) return false;
    if (reserved + cost > remaining) {
      rejected.push({
        modelSpecId: spec.id,
        reason: "budget",
        detail: `${reserved + cost} cumulative micro-USD exceeds remaining budget`
      });
      return false;
    }
    reserved += cost;
    return true;
  });
}

export function resolveRouteCandidates(
  route: ModelRoute,
  specs: ReadonlyMap<string, ModelSpec>,
  constraints: ModelRouteConstraints
): Pick<ModelResolution, "candidates" | "rejected"> {
  const candidates: ModelSpec[] = [];
  const rejected: ModelRejection[] = [];
  for (const id of route.candidates) {
    const spec = specs.get(id) as ModelSpec;
    const rejection = rejectionFor(spec, route, constraints);
    if (rejection) rejected.push(rejection); else candidates.push(spec);
  }
  return { candidates: withinCumulativeBudget(candidates, constraints, rejected), rejected };
}

export function validateRouteConstraints(constraints: ModelRouteConstraints): void {
  for (const [label, value] of [
    ["estimatedInputTokens", constraints.estimatedInputTokens],
    ["maxOutputTokens", constraints.maxOutputTokens],
    ["remainingBudgetMicroUsd", constraints.remainingBudgetMicroUsd],
    ["maxAttempts", constraints.maxAttempts]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Model route constraint '${label}' must be a non-negative safe integer.`);
    }
  }
}
