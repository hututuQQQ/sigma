import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "agent-protocol";
import {
  failureDiagnostics,
  ModelGatewayError,
  type ModelFailureDiagnostics,
  type ModelFailureCategory,
  type ModelRoute,
  type ModelRole,
  type ModelSpec
} from "./catalog.js";
import {
  estimatedRequestTokens,
  normalizeModelResponse,
  type NormalizedModelResponse
} from "./usage.js";
import { canFallback, classifyModelFailure } from "./failure-policy.js";
import { uniqueById, validateDistinctRoutes, validateRoute, validateSpec } from "./route-validation.js";
import {
  resolveRouteCandidates,
  validateRouteConstraints,
  type ModelRejection,
  type ModelResolution,
  type ModelRouteConstraints
} from "./route-policy.js";

export {
  APPROXIMATE_TOKEN_RESERVATION_MARGIN,
  mergeRequiredCapabilities,
  modelReservationEstimate,
  type ModelRejection,
  type ModelReservationEstimate,
  type ModelResolution,
  type ModelRouteConstraints
} from "./route-policy.js";

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

export interface ModelRouterOptions {
  maxRetriesPerCandidate?: number;
}

interface RoutedStreamLifecycle {
  semanticDelta: boolean;
  completed: boolean;
  lastEventType: string;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCall: boolean;
}

function observeRoutedStreamEvent(lifecycle: RoutedStreamLifecycle, event: ModelStreamEvent): void {
  lifecycle.lastEventType = event.type;
  if (event.type === "content") lifecycle.hasContent = true;
  if (event.type === "reasoning") lifecycle.hasReasoning = true;
  if (event.type === "tool_call") lifecycle.hasToolCall = true;
  if (event.type === "content" || event.type === "reasoning" || event.type === "tool_call") {
    lifecycle.semanticDelta = true;
  }
  if (event.type === "done") {
    lifecycle.semanticDelta = true;
    lifecycle.completed = true;
  }
}

function routedStreamEvent(
  event: ModelStreamEvent,
  role: ModelRole,
  routeId: string,
  spec: ModelSpec,
  request: ModelRequest,
  attempt: number,
  startedAt: number
): RoutedModelStreamEvent {
  if (event.type === "done") {
    return { type: "done", response: routedResponse(
      role, routeId, spec, event.response, request, attempt, performance.now() - startedAt
    ) };
  }
  if (event.type === "usage") return { ...event, routeId, modelSpecId: spec.id, attempt };
  return event;
}

function incompleteRoutedStreamError(
  spec: ModelSpec,
  lifecycle: RoutedStreamLifecycle,
  attempts: number
): ModelGatewayError {
  return Object.assign(
    new ModelGatewayError(
      `Model stream for '${spec.id}' ended without a terminal response (lastEventType=${lifecycle.lastEventType}, hasContent=${lifecycle.hasContent}, hasToolCall=${lifecycle.hasToolCall}).`,
      "protocol",
      lifecycle.semanticDelta,
      undefined,
      undefined,
      {
        provider: spec.providerId,
        model: spec.upstreamModel,
        category: "protocol",
        doneReceived: false,
        lastEventType: lifecycle.lastEventType,
        hasContent: lifecycle.hasContent,
        hasReasoning: lifecycle.hasReasoning,
        hasToolCall: lifecycle.hasToolCall,
        retryAttempts: attempts
      }
    ),
    { code: "model_stream_incomplete" }
  );
}

function retrySameProvider(category: ModelFailureCategory, spec: ModelSpec | undefined): boolean {
  return category === "rate_limit"
    || category === "network"
    || category === "server"
    || category === "timeout"
    || (category === "capacity" && spec?.providerId === "deepseek");
}

function executionCandidates(
  resolution: ModelResolution,
  retries: number,
  totalAttemptLimit: number | undefined
): ModelSpec[] {
  const candidates = resolution.candidates.slice(0, resolution.route.maxAttempts);
  const attempts = candidates.flatMap((spec) =>
    Array.from({ length: retries + 1 }, () => spec));
  return totalAttemptLimit === undefined ? attempts : attempts.slice(0, totalAttemptLimit);
}

function nextExecutionIndex(
  attempts: readonly ModelSpec[],
  currentIndex: number,
  category: ModelFailureCategory
): number | undefined {
  const current = attempts[currentIndex];
  const next = attempts[currentIndex + 1];
  if (retrySameProvider(category, current) && next?.id === current?.id) return currentIndex + 1;
  const nextProvider = attempts.findIndex((spec, index) =>
    index > currentIndex && spec.id !== current?.id);
  return nextProvider < 0 ? undefined : nextProvider;
}

export class ModelRoutingError extends Error {
  readonly code = "model_route_unavailable";
  constructor(readonly routeId: string, readonly rejected: readonly ModelRejection[]) {
    super(`Model route '${routeId}' has no eligible candidates.`);
    this.name = "ModelRoutingError";
  }
}

export class ModelRouteExecutionError extends Error {
  readonly code = "model_route_failed";
  readonly diagnostics?: ModelFailureDiagnostics;
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
    const causeDiagnostics = failureDiagnostics(options?.cause);
    this.diagnostics = {
      ...causeDiagnostics,
      category,
      retryAttempts: causeDiagnostics?.retryAttempts ?? attempts
    };
  }
}

export class ModelRouter {
  private readonly specs: ReadonlyMap<string, ModelSpec>;
  private readonly routes: ReadonlyMap<string, ModelRoute>;
  private readonly maxRetriesPerCandidate: number;

  constructor(
    specs: readonly ModelSpec[],
    routes: readonly ModelRoute[],
    private readonly gateways: ModelGatewayFactory,
    options: ModelRouterOptions = {}
  ) {
    for (const spec of specs) validateSpec(spec);
    this.specs = uniqueById(specs, "model spec");
    this.routes = uniqueById(routes, "model route");
    const retries = options.maxRetriesPerCandidate ?? 0;
    if (!Number.isSafeInteger(retries) || retries < 0) {
      throw new Error("Model router retries must be a non-negative safe integer.");
    }
    this.maxRetriesPerCandidate = retries;
    validateDistinctRoutes(routes);
    for (const route of routes) validateRoute(route, this.specs);
  }

  resolve(routeId: string, constraints: ModelRouteConstraints = {}): ModelResolution {
    const route = this.routes.get(routeId);
    if (!route) throw new Error(`Unknown model route '${routeId}'.`);
    validateRouteConstraints(constraints);
    const { candidates, rejected } = resolveRouteCandidates(route, this.specs, constraints);
    if (candidates.length === 0) throw new ModelRoutingError(routeId, rejected);
    return { route, candidates, rejected };
  }

  plannedAttempts(
    routeId: string,
    constraints: ModelRouteConstraints = {}
  ): readonly ModelSpec[] {
    return executionCandidates(
      this.resolve(routeId, constraints),
      this.maxRetriesPerCandidate,
      constraints.maxAttempts
    );
  }

  async complete(
    role: ModelRole,
    routeId: string,
    request: ModelRequest,
    constraints: ModelRouteConstraints = {}
  ): Promise<RoutedModelResponse> {
    const resolution = this.resolveForRequest(routeId, request, constraints);
    const planned = executionCandidates(
      resolution,
      this.maxRetriesPerCandidate,
      constraints.maxAttempts
    );
    let lastError: unknown;
    let executed = 0;
    for (let index = 0; index < planned.length;) {
      request.signal.throwIfAborted();
      const spec = planned[index] as ModelSpec;
      const attempt = executed++;
      const startedAt = performance.now();
      try {
        const response = await this.gateways(spec).complete(request);
        return routedResponse(
          role,
          resolution.route.id,
          spec,
          response,
          request,
          attempt,
          performance.now() - startedAt
        );
      } catch (error) {
        request.signal.throwIfAborted();
        lastError = error;
        const category = classifyModelFailure(error);
        const semanticDelta = errorSemanticDelta(error);
        const nextIndex = nextExecutionIndex(planned, index, category);
        if (!canFallback(resolution.route, category, semanticDelta) || nextIndex === undefined) {
          throw new ModelRouteExecutionError(
            routeId,
            spec.id,
            category,
            semanticDelta,
            executed,
            { cause: error }
          );
        }
        index = nextIndex;
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
    const planned = executionCandidates(
      resolution,
      this.maxRetriesPerCandidate,
      constraints.maxAttempts
    );
    let executed = 0;
    for (let index = 0; index < planned.length;) {
      request.signal.throwIfAborted();
      const spec = planned[index] as ModelSpec;
      const attempt = executed++;
      const startedAt = performance.now();
      const lifecycle: RoutedStreamLifecycle = {
        semanticDelta: false,
        completed: false,
        lastEventType: "none",
        hasContent: false,
        hasReasoning: false,
        hasToolCall: false
      };
      try {
        for await (const event of this.gateways(spec).stream(request)) {
          observeRoutedStreamEvent(lifecycle, event);
          yield routedStreamEvent(event, role, routeId, spec, request, attempt, startedAt);
        }
        if (!lifecycle.completed) {
          request.signal.throwIfAborted();
          throw incompleteRoutedStreamError(spec, lifecycle, executed);
        }
        return;
      } catch (error) {
        request.signal.throwIfAborted();
        const category = classifyModelFailure(error);
        lifecycle.semanticDelta ||= errorSemanticDelta(error);
        const nextIndex = nextExecutionIndex(planned, index, category);
        if (!canFallback(resolution.route, category, lifecycle.semanticDelta)
          || nextIndex === undefined) {
          throw new ModelRouteExecutionError(
            routeId,
            spec.id,
            category,
            lifecycle.semanticDelta,
            executed,
            { cause: error }
          );
        }
        index = nextIndex;
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
