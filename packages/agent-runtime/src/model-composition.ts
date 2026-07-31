import type { ModelRouteConfigValue, ModelSpecConfigValue } from "agent-config";
import type { FrozenAgentProfile } from "agent-extensions";
import {
  BUILTIN_MODEL_SPECS,
  createModelGatewayForSpec,
  defaultModel,
  ModelRouter,
  RoutedModelGateway,
  type ModelRoute,
  type ModelRouteConstraints,
  type ModelReasoningEffort,
  type ModelSpec
} from "agent-model";
import type { ModelExecutionRole, ModelGateway } from "agent-protocol";
import type { RuntimeCustomization } from "./customization.js";

const DEFAULT_MODEL_RETRIES = 5;
const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_MODEL_RETRY_JITTER_RATIO = 0.1;

export interface ModelCompositionConfig {
  provider: string;
  model: string;
  modelDeadlineSec: number;
  streamIdleSec: number;
  streamActiveSec?: number;
  maxModelRetries?: number;
  explicitSingleModelRoute?: boolean;
  modelSpecs?: readonly ModelSpecConfigValue[];
  modelRoutes?: readonly ModelRouteConfigValue[];
  reasoningEffort?: ModelReasoningEffort;
  budget?: { maxCostMicroUsd: number; allowUnpricedCosts?: boolean };
}

interface ModelGatewayFactoryOptions {
  provider: string;
  model: string;
  maxRetries: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  activeStreamTimeoutMs?: number;
  reasoningEffort?: ModelReasoningEffort;
}

export interface ModelCompositionDeps {
  gatewayFactory?: (options: ModelGatewayFactoryOptions) => ModelGateway;
  catalogSpecs?: readonly ModelSpec[];
}

export interface ModelGateways {
  orchestrator: RoutedModelGateway;
  reviewer: RoutedModelGateway;
  forRole(role: ModelExecutionRole, profile: FrozenAgentProfile | undefined): RoutedModelGateway;
}

const FALLBACK_ON = ["rate_limit", "capacity", "network", "server", "timeout"] as const;
const TOOL_ROLES = new Set<ModelExecutionRole>([
  "orchestrator",
  "reviewer",
  "child_analyze",
  "child_write"
]);

function hasCredential(provider: ModelSpec["providerId"], env: NodeJS.ProcessEnv): boolean {
  if (provider === "deepseek") return Boolean(env.DEEPSEEK_API_KEY?.trim());
  if (provider === "glm") {
    return Boolean(env.GLM_API_KEY?.trim() || env.ZAI_API_KEY?.trim() || env.BIGMODEL_API_KEY?.trim());
  }
  return false;
}

export function productionModelCandidates(
  config: Pick<ModelCompositionConfig, "provider" | "model" | "explicitSingleModelRoute">,
  env: NodeJS.ProcessEnv = process.env,
  catalogSpecs: readonly ModelSpec[] = BUILTIN_MODEL_SPECS
): ModelSpec[] {
  const model = selectedModel(config, env, catalogSpecs);
  const primary = catalogSpecs.find((spec) =>
    spec.providerId === config.provider && spec.upstreamModel === model);
  if (!primary) return [];
  if (config.explicitSingleModelRoute || (primary.providerId !== "deepseek" && primary.providerId !== "glm")) {
    return [primary];
  }
  const fallbackProvider = primary.providerId === "deepseek" ? "glm" : "deepseek";
  const fallback = hasCredential(fallbackProvider, env)
    ? catalogSpecs.find((spec) =>
        spec.providerId === fallbackProvider
        && spec.upstreamModel === defaultModel(fallbackProvider, env))
    : undefined;
  return fallback ? [primary, fallback] : [primary];
}

function injectedModelSpec(
  provider: string,
  model: string,
  gateway: ModelGateway
): ModelSpec {
  const base: ModelSpec = {
    id: `${provider}/${model}`,
    providerId: provider,
    upstreamModel: model,
    billingMode: provider === "openai-codex" ? "subscription" : "unpriced",
    capabilities: gateway.capabilities,
    tokenizer: { id: "injected/test-tokenizer", accuracy: "approximate" }
  };
  return base;
}

function configuredSpec(value: ModelSpecConfigValue): ModelSpec {
  return {
    ...value,
    billingMode: value.billingMode ?? "metered"
  };
}

function configuredRoute(value: ModelRouteConfigValue): ModelRoute {
  return { ...value };
}

function selectedModel(
  config: Pick<ModelCompositionConfig, "provider" | "model">,
  env: NodeJS.ProcessEnv,
  catalogSpecs: readonly ModelSpec[]
): string {
  if (config.model !== "auto") return config.model;
  try {
    return defaultModel(config.provider, env);
  } catch (error) {
    const cached = catalogSpecs.find((spec) => spec.providerId === config.provider);
    if (cached) return cached.upstreamModel;
    throw error;
  }
}

function explicitSpecs(
  config: ModelCompositionConfig,
  catalogSpecs: readonly ModelSpec[]
): ModelSpec[] {
  const builtins = new Set(catalogSpecs.map((spec) => spec.id));
  const ids = new Set<string>();
  return (config.modelSpecs ?? []).map((value) => {
    if (builtins.has(value.id)) throw new Error(`Custom model spec '${value.id}' cannot override fixed built-in catalog data.`);
    if (catalogSpecs.some((spec) =>
      spec.providerId === value.providerId && spec.upstreamModel === value.upstreamModel)) {
      throw new Error(`Custom model spec '${value.id}' cannot alias a built-in model with different catalog data.`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate custom model spec id '${value.id}'.`);
    ids.add(value.id);
    if ((value.billingMode ?? "metered") === "metered" && !value.pricing) {
      throw new Error(`Custom model '${value.id}' requires explicit pricing while a cost cap is enabled.`);
    }
    return configuredSpec(value);
  });
}

function catalog(
  config: ModelCompositionConfig,
  env: NodeJS.ProcessEnv,
  custom: readonly ModelSpec[],
  injected: ModelSpec | undefined,
  catalogSpecs: readonly ModelSpec[]
): { primary: ModelSpec; specs: ModelSpec[]; routes: ModelRoute[] } {
  const model = selectedModel(config, env, catalogSpecs);
  const primary = catalogSpecs.find((spec) =>
    spec.providerId === config.provider && spec.upstreamModel === model)
    ?? custom.find((spec) => spec.providerId === config.provider && spec.upstreamModel === model)
    ?? injected;
  if (!primary) {
    throw new Error(`Custom model '${config.provider}/${model}' requires explicit capabilities, tokenizer, and pricing.`);
  }
  const available = new Map<string, ModelSpec>([
    ...catalogSpecs.map((spec) => [spec.id, spec] as const),
    ...custom.map((spec) => [spec.id, spec] as const)
  ]);
  available.set(primary.id, primary);
  const explicitRoutes = (config.modelRoutes ?? []).map(configuredRoute);
  let routes: ModelRoute[];
  if (config.explicitSingleModelRoute
    || (explicitRoutes.length === 0 && primary.providerId !== "deepseek" && primary.providerId !== "glm")) {
    routes = [{ id: "default", candidates: [primary.id], fallbackOn: FALLBACK_ON, maxAttempts: 1 }];
  } else if (explicitRoutes.length > 0) {
    routes = explicitRoutes;
  } else {
    const candidates = productionModelCandidates(config, env, catalogSpecs).map((spec) => spec.id);
    if (!candidates.includes(primary.id)) candidates.unshift(primary.id);
    routes = [{ id: "default", candidates, fallbackOn: FALLBACK_ON, maxAttempts: candidates.length }];
  }
  const referenced = new Set([primary.id, ...routes.flatMap((route) => route.candidates)]);
  const specs = [...referenced].map((id) => available.get(id)).filter((spec): spec is ModelSpec => Boolean(spec));
  return { primary, specs, routes };
}

function constraintsForRole(
  role: ModelExecutionRole,
  allowUnpricedCosts = false
): ModelRouteConstraints {
  return {
    ...(TOOL_ROLES.has(role) ? { requiredCapabilities: { tools: true } } : {}),
    allowUnpricedCosts
  };
}

function validateProfileRoutes(
  router: ModelRouter,
  customization: RuntimeCustomization,
  allowUnpricedCosts: boolean
): void {
  const profiles = [customization.profile, ...customization.availableProfiles.map((item) => item.profile)];
  for (const profile of profiles) {
    for (const [role, routeId] of Object.entries(profile.profile.roleRoutes)) {
      if (!routeId) continue;
      try {
        router.resolve(routeId, constraintsForRole(role as ModelExecutionRole, allowUnpricedCosts));
      } catch (error) {
        throw new Error(`Agent Profile '${profile.profile.id}' has unusable ${role} route '${routeId}'.`, { cause: error });
      }
    }
  }
}

function gatewayOptions(config: ModelCompositionConfig): Omit<
  ModelGatewayFactoryOptions,
  "provider" | "model"
> {
  return {
    maxRetries: config.maxModelRetries ?? DEFAULT_MODEL_RETRIES,
    requestTimeoutMs: config.modelDeadlineSec * 1_000,
    idleTimeoutMs: config.streamIdleSec * 1_000,
    ...(config.streamActiveSec && config.streamActiveSec > 0
      ? { activeStreamTimeoutMs: config.streamActiveSec * 1_000 }
      : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {})
  };
}

function transportOptions(
  options: Omit<ModelGatewayFactoryOptions, "provider" | "model">
): Omit<ModelGatewayFactoryOptions, "provider" | "model" | "maxRetries"> {
  const { maxRetries: _policyRetries, ...transport } = options;
  void _policyRetries;
  return transport;
}

function primaryGateway(
  provider: string,
  model: string,
  spec: ModelSpec | undefined,
  deps: ModelCompositionDeps,
  options: Omit<ModelGatewayFactoryOptions, "provider" | "model">
): ModelGateway {
  const injected = deps.gatewayFactory?.({ provider, model, ...options });
  if (injected) return injected;
  if (!spec) {
    throw new Error(`Custom model '${provider}/${model}' requires explicit capabilities, tokenizer, and pricing.`);
  }
  return createModelGatewayForSpec(spec, transportOptions(options));
}

function gatewayForSpec(
  spec: ModelSpec,
  deps: ModelCompositionDeps,
  options: Omit<ModelGatewayFactoryOptions, "provider" | "model">
): ModelGateway {
  return deps.gatewayFactory?.({
    provider: spec.providerId,
    model: spec.upstreamModel,
    ...options
  }) ?? createModelGatewayForSpec(spec, transportOptions(options));
}

export function createRoleGateways(
  config: ModelCompositionConfig,
  deps: ModelCompositionDeps,
  customization: RuntimeCustomization,
  env: NodeJS.ProcessEnv = process.env
): ModelGateways {
  const catalogSpecs = deps.catalogSpecs ?? BUILTIN_MODEL_SPECS;
  const model = selectedModel(config, env, catalogSpecs);
  const custom = explicitSpecs(config, catalogSpecs);
  const knownPrimary = catalogSpecs.find((spec) =>
    spec.providerId === config.provider && spec.upstreamModel === model)
    ?? custom.find((spec) => spec.providerId === config.provider && spec.upstreamModel === model);
  const options = gatewayOptions(config);
  const primary = primaryGateway(config.provider, model, knownPrimary, deps, options);
  const injected = knownPrimary ? undefined : injectedModelSpec(config.provider, model, primary);
  const resolved = catalog(config, env, custom, injected, catalogSpecs);
  const gateways = new Map<string, ModelGateway>();
  for (const spec of resolved.specs) {
    const gateway = spec.id === resolved.primary.id
      ? primary
      : gatewayForSpec(spec, deps, options);
    gateways.set(spec.id, gateway);
  }
  const router = new ModelRouter(
    resolved.specs,
    resolved.routes,
    (spec) => gateways.get(spec.id) as ModelGateway,
    {
      maxRetriesPerCandidate: config.maxModelRetries ?? DEFAULT_MODEL_RETRIES,
      retryBaseDelayMs: DEFAULT_MODEL_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: 60_000,
      retryJitterRatio: DEFAULT_MODEL_RETRY_JITTER_RATIO
    }
  );
  const allowUnpricedCosts = config.budget?.allowUnpricedCosts === true;
  validateProfileRoutes(router, customization, allowUnpricedCosts);
  const cache = new Map<string, RoutedModelGateway>();
  const forRole = (role: ModelExecutionRole, profile: FrozenAgentProfile | undefined): RoutedModelGateway => {
    const routeId = profile?.profile.roleRoutes[role] ?? "default";
    const key = `${role}\0${routeId}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const constraints = constraintsForRole(role, allowUnpricedCosts);
    const representativeSpec = router.resolve(routeId, constraints).candidates[0] as ModelSpec;
    const gateway = new RoutedModelGateway({
      router,
      role,
      routeId,
      representative: gateways.get(representativeSpec.id) as ModelGateway,
      constraints: () => constraints
    });
    cache.set(key, gateway);
    return gateway;
  };
  return {
    orchestrator: forRole("orchestrator", customization.profile),
    reviewer: forRole("reviewer", customization.profile),
    forRole
  };
}

export function reviewerRouteId(profile: FrozenAgentProfile | undefined): string {
  return `route:${profile?.profile.roleRoutes.reviewer ?? "default"}`;
}
