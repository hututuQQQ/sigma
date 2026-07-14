import type {
  ModelCapabilities,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "agent-protocol";
import type {
  ModelFailureCategory,
  ModelRoute,
  ModelRole,
  ModelSpec
} from "./catalog.js";
import {
  estimatedRequestTokens,
  normalizeModelResponse,
  type NormalizedModelResponse
} from "./usage.js";
import { canFallback, classifyModelFailure } from "./failure-policy.js";
import { uniqueById, validateDistinctRoutes, validateRoute, validateSpec } from "./route-validation.js";

export interface ModelRouteConstraints {
  requiredCapabilities?: Partial<ModelCapabilities>;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  remainingBudgetMicroUsd?: number;
  requireExactTokenizer?: boolean;
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

export interface RoutedModelResponse extends NormalizedModelResponse {
  routeId: string;
  role: ModelRole;
  modelSpecId: string;
  attempt: number;
  providerId: string;
  tokenizerId: string;
  tokenizerAccuracy: "exact" | "approximate";
  tokenizerAssetDigest?: string;
}

export type RoutedModelStreamEvent =
  | Exclude<ModelStreamEvent, { type: "done" } | { type: "usage" }>
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      routeId: string;
      modelSpecId: string;
      attempt: number;
    }
  | { type: "done"; response: RoutedModelResponse };

export type ModelGatewayFactory = (spec: ModelSpec) => ModelGateway;

export class ModelRoutingError extends Error {
  readonly code = "model_route_unavailable";
  constructor(readonly routeId: string, readonly rejected: readonly ModelRejection[]) {
    super(`Model route '${routeId}' has no eligible candidates.`);
    this.name = "ModelRoutingError";
  }
}

export class ModelRouteExecutionError extends Error {
  readonly code = "model_route_failed";
  constructor(
    readonly routeId: string,
    readonly modelSpecId: string,
    readonly category: ModelFailureCategory,
    readonly semanticDelta: boolean,
    readonly attempts: number,
    options?: ErrorOptions
  ) {
    super(`Model route '${routeId}' failed on '${modelSpecId}' (${category}).`, options);
    this.name = "ModelRouteExecutionError";
  }
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
  for (const [key, value] of Object.entries(required) as Array<[keyof ModelCapabilities, ModelCapabilities[keyof ModelCapabilities]]>) {
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

function rejectionFor(spec: ModelSpec, route: ModelRoute, constraints: ModelRouteConstraints): ModelRejection | undefined {
  const capability = capabilityFailure(spec, mergeRequiredCapabilities(
    route.requiredCapabilities ?? {},
    constraints.requiredCapabilities ?? {}
  ));
  if (capability) return { modelSpecId: spec.id, reason: "capability", detail: capability };
  if ((route.requireExactTokenizer || constraints.requireExactTokenizer) && spec.tokenizer.accuracy !== "exact") {
    return { modelSpecId: spec.id, reason: "tokenizer", detail: "exact tokenizer required" };
  }
  const context = contextRequirement(spec, constraints);
  if (context > spec.capabilities.contextWindowTokens || (constraints.maxOutputTokens ?? 0) > spec.capabilities.maxOutputTokens) {
    return { modelSpecId: spec.id, reason: "context", detail: `${context} tokens exceed candidate limits` };
  }
  if (constraints.remainingBudgetMicroUsd !== undefined) {
    const cost = maximumCost(spec, constraints);
    if (cost === null) return { modelSpecId: spec.id, reason: "pricing", detail: "cost budget requires model pricing" };
    if (cost > constraints.remainingBudgetMicroUsd) {
      return { modelSpecId: spec.id, reason: "budget", detail: `${cost} micro-USD exceeds remaining budget` };
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

export class ModelRouter {
  private readonly specs: ReadonlyMap<string, ModelSpec>;
  private readonly routes: ReadonlyMap<string, ModelRoute>;

  constructor(specs: readonly ModelSpec[], routes: readonly ModelRoute[], private readonly gateways: ModelGatewayFactory) {
    for (const spec of specs) validateSpec(spec);
    this.specs = uniqueById(specs, "model spec");
    this.routes = uniqueById(routes, "model route");
    validateDistinctRoutes(routes);
    for (const route of routes) validateRoute(route, this.specs);
  }

  resolve(routeId: string, constraints: ModelRouteConstraints = {}): ModelResolution {
    const route = this.routes.get(routeId);
    if (!route) throw new Error(`Unknown model route '${routeId}'.`);
    validateConstraints(constraints);
    const candidates: ModelSpec[] = [];
    const rejected: ModelRejection[] = [];
    for (const id of route.candidates) {
      const spec = this.specs.get(id) as ModelSpec;
      const rejection = rejectionFor(spec, route, constraints);
      if (rejection) rejected.push(rejection); else candidates.push(spec);
    }
    const affordable = withinCumulativeBudget(candidates, constraints, rejected);
    if (affordable.length === 0) throw new ModelRoutingError(routeId, rejected);
    return { route, candidates: affordable, rejected };
  }

  async complete(
    role: ModelRole,
    routeId: string,
    request: ModelRequest,
    constraints: ModelRouteConstraints = {}
  ): Promise<RoutedModelResponse> {
    const resolution = this.resolveForRequest(routeId, request, constraints);
    let lastError: unknown;
    const attempts = Math.min(resolution.route.maxAttempts, resolution.candidates.length);
    for (let index = 0; index < attempts; index += 1) {
      request.signal.throwIfAborted();
      const spec = resolution.candidates[index] as ModelSpec;
      const startedAt = performance.now();
      try {
        const response = await this.gateways(spec).complete(request);
        return routedResponse(role, resolution.route.id, spec, response, request, index, performance.now() - startedAt);
      } catch (error) {
        request.signal.throwIfAborted();
        lastError = error;
        const category = classifyModelFailure(error);
        const semanticDelta = errorSemanticDelta(error);
        if (!canFallback(resolution.route, category, semanticDelta) || index + 1 >= attempts) {
          throw new ModelRouteExecutionError(routeId, spec.id, category, semanticDelta, index + 1, { cause: error });
        }
      }
    }
    throw lastError;
  }

  async *stream(
    role: ModelRole,
    routeId: string,
    request: ModelRequest,
    constraints: ModelRouteConstraints = {}
  ): AsyncIterable<RoutedModelStreamEvent> {
    const resolution = this.resolveForRequest(routeId, request, constraints);
    const attempts = Math.min(resolution.route.maxAttempts, resolution.candidates.length);
    for (let index = 0; index < attempts; index += 1) {
      request.signal.throwIfAborted();
      const spec = resolution.candidates[index] as ModelSpec;
      const startedAt = performance.now();
      let semanticDelta = false;
      let completed = false;
      try {
        for await (const event of this.gateways(spec).stream(request)) {
          if (event.type === "content" || event.type === "reasoning" || event.type === "tool_call") semanticDelta = true;
          if (event.type === "done") {
            semanticDelta = true;
            completed = true;
            yield { type: "done", response: routedResponse(
              role, routeId, spec, event.response, request, index, performance.now() - startedAt
            ) };
          } else if (event.type === "usage") {
            yield { ...event, routeId, modelSpecId: spec.id, attempt: index };
          } else yield event;
        }
        if (!completed) {
          request.signal.throwIfAborted();
          throw Object.assign(
            new Error(`Model stream for '${spec.id}' ended without a terminal response.`),
            { category: "network", semanticDelta }
          );
        }
        return;
      } catch (error) {
        request.signal.throwIfAborted();
        const category = classifyModelFailure(error);
        semanticDelta ||= errorSemanticDelta(error);
        if (!canFallback(resolution.route, category, semanticDelta) || index + 1 >= attempts) {
          throw new ModelRouteExecutionError(routeId, spec.id, category, semanticDelta, index + 1, { cause: error });
        }
      }
    }
  }

  private resolveForRequest(
    routeId: string,
    request: ModelRequest,
    constraints: ModelRouteConstraints
  ): ModelResolution {
    return this.resolve(routeId, {
      ...constraints,
      estimatedInputTokens: constraints.estimatedInputTokens ?? estimatedRequestTokens(request),
      maxOutputTokens: constraints.maxOutputTokens ?? request.maxOutputTokens
    });
  }
}

function errorSemanticDelta(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { semanticDelta?: unknown }).semanticDelta === true);
}

function routedResponse(
  role: ModelRole,
  routeId: string,
  spec: ModelSpec,
  response: ModelResponse,
  request: ModelRequest,
  attempt: number,
  latencyMs: number
): RoutedModelResponse {
  return {
    ...normalizeModelResponse({ spec, request, response, latencyMs, retryAttempt: attempt }),
    routeId,
    role,
    modelSpecId: spec.id,
    attempt,
    providerId: spec.providerId,
    tokenizerId: spec.tokenizer.id,
    tokenizerAccuracy: spec.tokenizer.accuracy,
    ...(spec.tokenizer.assetDigest ? { tokenizerAssetDigest: spec.tokenizer.assetDigest } : {})
  };
}

function validateConstraints(constraints: ModelRouteConstraints): void {
  for (const [label, value] of [
    ["estimatedInputTokens", constraints.estimatedInputTokens],
    ["maxOutputTokens", constraints.maxOutputTokens],
    ["remainingBudgetMicroUsd", constraints.remainingBudgetMicroUsd]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Model route constraint '${label}' must be a non-negative safe integer.`);
    }
  }
}
