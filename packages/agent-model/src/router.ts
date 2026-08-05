import type {
  ModelGateway,
  ModelRequest,
  ModelStreamEvent
} from "agent-protocol";
import {
  failureDiagnostics,
  type ModelFailureDiagnostics,
  type ModelFailureCategory,
  type ModelRoute,
  type ModelRole,
  type ModelSpec
} from "./catalog.js";
import {
  estimatedRequestTokens,
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
import {
  abortableDelay,
  executionCandidates,
  nextExecutionIndex,
  retryDelay,
  safeProtocolRetry
} from "./router-retry.js";
import {
  incompleteRoutedStreamError,
  newRoutedStreamLifecycle,
  observeRoutedStreamEvent,
  routedResponse,
  type RoutedStreamLifecycle
} from "./router-stream.js";

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
  /** Base delay before retrying the same provider/model. Defaults to no delay. */
  retryBaseDelayMs?: number;
  /** Maximum delay between same-provider retries. */
  retryMaxDelayMs?: number;
  /** Symmetric randomization ratio applied to same-provider retry delays. */
  retryJitterRatio?: number;
}

function validatedRetryJitterRatio(value: number | undefined): number {
  const ratio = value ?? 0;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error("Model router retry jitter ratio must be between 0 and 1.");
  }
  return ratio;
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

function blocksStreamRetry(
  lifecycle: RoutedStreamLifecycle,
  current: ModelSpec,
  next: ModelSpec | undefined
): boolean {
  if (!lifecycle.semanticDelta) return false;
  // Reasoning deltas are observable but are not committed to conversation
  // history and cannot execute tools. A transient retry is therefore safe only
  // on the same provider/model before content, tool calls, or a terminal event.
  return next?.id !== current.id
    || lifecycle.hasContent
    || lifecycle.hasToolCall
    || lifecycle.completed;
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
  private readonly sessionGateways = new Map<string, Set<ModelGateway>>();
  private readonly maxRetriesPerCandidate: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryJitterRatio: number;

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
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 0;
    const retryMaxDelayMs = options.retryMaxDelayMs ?? 60_000;
    const retryJitterRatio = validatedRetryJitterRatio(options.retryJitterRatio);
    if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 0) {
      throw new Error("Model router retry base delay must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(retryMaxDelayMs) || retryMaxDelayMs < 0) {
      throw new Error("Model router maximum retry delay must be a non-negative safe integer.");
    }
    this.maxRetriesPerCandidate = retries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.retryJitterRatio = retryJitterRatio;
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

  private gatewayFor(spec: ModelSpec, sessionId?: string): ModelGateway {
    const gateway = this.gateways(spec);
    if (!sessionId) return gateway;
    const used = this.sessionGateways.get(sessionId) ?? new Set<ModelGateway>();
    used.add(gateway);
    this.sessionGateways.set(sessionId, used);
    return gateway;
  }

  async releaseSession(sessionId: string): Promise<void> {
    const gateways = this.sessionGateways.get(sessionId);
    this.sessionGateways.delete(sessionId);
    if (!gateways) return;
    const settled = await Promise.allSettled(
      [...gateways].map(async (gateway) => gateway.releaseSession?.(sessionId))
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to release routed model session resources");
    }
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
        const response = await this.gatewayFor(spec, request.sessionId).complete(request);
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
        const retryProtocol = safeProtocolRetry(
          error,
          category,
          planned,
          index,
          nextIndex,
          semanticDelta
        );
        if ((!retryProtocol && !canFallback(resolution.route, category, semanticDelta))
          || nextIndex === undefined) {
          throw new ModelRouteExecutionError(
            routeId,
            spec.id,
            category,
            semanticDelta,
            executed,
            { cause: error }
          );
        }
        await abortableDelay(
          retryDelay(
            planned,
            index,
            nextIndex,
            this.retryBaseDelayMs,
            this.retryMaxDelayMs,
            this.retryJitterRatio
          ),
          request.signal
        );
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
      const lifecycle: RoutedStreamLifecycle = newRoutedStreamLifecycle();
      try {
        for await (const event of this.gatewayFor(spec, request.sessionId).stream(request)) {
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
        const next = nextIndex === undefined ? undefined : planned[nextIndex];
        const blocksRetry = blocksStreamRetry(lifecycle, spec, next);
        const retryProtocol = safeProtocolRetry(
          error,
          category,
          planned,
          index,
          nextIndex,
          blocksRetry
        );
        if ((!retryProtocol && !canFallback(resolution.route, category, blocksRetry))
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
        await abortableDelay(
          retryDelay(
            planned,
            index,
            nextIndex,
            this.retryBaseDelayMs,
            this.retryMaxDelayMs,
            this.retryJitterRatio
          ),
          request.signal
        );
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
