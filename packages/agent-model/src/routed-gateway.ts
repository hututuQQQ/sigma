import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "agent-protocol";
import type { ModelRole } from "./catalog.js";
import {
  ModelRouter,
  mergeRequiredCapabilities,
  modelReservationEstimate,
  type ModelResolution,
  type ModelReservationEstimate,
  type ModelRouteConstraints
} from "./router.js";

export interface RoutedModelGatewayOptions {
  router: ModelRouter;
  role: ModelRole;
  routeId: string;
  representative: ModelGateway;
  constraints?: () => ModelRouteConstraints;
}

export interface RoutedBudgetPlan {
  estimatedInputTokens: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostMicroUsd: number;
  reservedModelTurns: number;
  attemptReservations: readonly ModelReservationEstimate[];
  constraints: ModelRouteConstraints;
}

function conservativeTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Model gateway token counts must be finite and non-negative.");
  }
  const count = Math.ceil(value);
  if (!Number.isSafeInteger(count)) throw new Error("Model gateway token count exceeds the safe integer range.");
  return count;
}

function mergeConstraints(
  base: ModelRouteConstraints,
  override: ModelRouteConstraints
): ModelRouteConstraints {
  return {
    ...base,
    ...override,
    requiredCapabilities: mergeRequiredCapabilities(
      base.requiredCapabilities ?? {},
      override.requiredCapabilities ?? {}
    )
  };
}

function routedTokenizerExpansionBound(
  resolution: ModelResolution,
  constraints: ModelRouteConstraints
): number | undefined {
  const attempts = Math.min(
    resolution.route.maxAttempts,
    constraints.maxAttempts ?? resolution.route.maxAttempts,
    resolution.candidates.length
  );
  const bounds = resolution.candidates.slice(0, attempts)
    .map((spec) => spec.tokenizer.maxTokensPerUtf8Byte);
  if (bounds.length === 0 || bounds.some((value) => value === undefined)) return undefined;
  return Math.max(...bounds as number[]);
}

/** Adapts the role-aware deterministic router to the runtime's gateway port. */
export class RoutedModelGateway implements ModelGateway {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  readonly maxTokensPerUtf8Byte: number | undefined;
  private readonly router: ModelRouter;
  private readonly role: ModelRole;
  private readonly routeId: string;
  private readonly representative: ModelGateway;
  private readonly constraints: () => ModelRouteConstraints;

  constructor(options: RoutedModelGatewayOptions) {
    this.router = options.router;
    this.role = options.role;
    this.routeId = options.routeId;
    this.representative = options.representative;
    this.constraints = options.constraints ?? (() => ({}));
    this.provider = options.representative.provider;
    this.model = options.representative.model;
    this.capabilities = options.representative.capabilities;
    // Resolve eagerly so configuration/profile errors fail before a session starts.
    // The bound comes only from the frozen route specs; a provider response or
    // representative gateway cannot expand its own accounting authority.
    const initialConstraints = this.constraints();
    const resolution = this.router.resolve(this.routeId, initialConstraints);
    this.maxTokensPerUtf8Byte = routedTokenizerExpansionBound(resolution, initialConstraints);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return await this.router.complete(this.role, this.routeId, request, this.constraints());
  }

  async completeWithConstraints(
    request: ModelRequest,
    constraints: ModelRouteConstraints
  ): Promise<ModelResponse> {
    return await this.router.complete(
      this.role,
      this.routeId,
      request,
      mergeConstraints(this.constraints(), constraints)
    );
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield* this.streamWithConstraints(request, {});
  }

  async *streamWithConstraints(
    request: ModelRequest,
    constraints: ModelRouteConstraints
  ): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.router.stream(
      this.role,
      this.routeId,
      request,
      mergeConstraints(this.constraints(), constraints)
    )) {
      yield event;
    }
  }

  async budgetPlan(
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
    maxOutputTokens: number,
    remainingBudgetMicroUsd: number,
    minimumInputTokens = 0
  ): Promise<RoutedBudgetPlan> {
    const estimatedInputTokens = Math.max(
      conservativeTokenCount(await this.representative.countTokens(messages, tools)),
      conservativeTokenCount(minimumInputTokens)
    );
    const constraints: ModelRouteConstraints = {
      ...this.constraints(),
      estimatedInputTokens,
      maxOutputTokens,
      remainingBudgetMicroUsd
    };
    const resolution = this.router.resolve(this.routeId, constraints);
    const estimates = resolution.candidates
      .slice(0, resolution.route.maxAttempts)
      .map((spec) => modelReservationEstimate(spec, constraints));
    return {
      estimatedInputTokens,
      reservedInputTokens: estimates.reduce((total, item) => total + item.inputTokens, 0),
      reservedOutputTokens: estimates.reduce((total, item) => total + item.outputTokens, 0),
      reservedCostMicroUsd: estimates.reduce((total, item) => total + (item.costMicroUsd ?? 0), 0),
      reservedModelTurns: estimates.length,
      attemptReservations: estimates,
      constraints
    };
  }

  routingIdentity(): { role: ModelRole; routeId: string } {
    return { role: this.role, routeId: this.routeId };
  }

  async countTokens(messages: ModelMessage[], tools?: ModelToolDefinition[]): Promise<number> {
    return await this.representative.countTokens(messages, tools);
  }
}
