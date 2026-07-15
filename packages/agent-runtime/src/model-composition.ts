import type { ModelRouteConfigValue, ModelSpecConfigValue } from "agent-config";
import type { FrozenAgentProfile } from "agent-extensions";
import {
  BUILTIN_MODEL_SPECS,
  builtinModelSpec,
  createModelGatewayForSpec,
  defaultModel,
  ModelRouter,
  RoutedModelGateway,
  type ModelRoute,
  type ModelRouteConstraints,
  type ModelSpec
} from "agent-model";
import type { ModelExecutionRole, ModelGateway } from "agent-protocol";
import type { RuntimeCustomization } from "./customization.js";

export interface ModelCompositionConfig {
  provider: "deepseek" | "glm";
  model: string;
  modelDeadlineSec: number;
  streamIdleSec: number;
  streamActiveSec?: number;
  maxModelRetries?: number;
  legacySingleModelRoute?: boolean;
  modelSpecs?: readonly ModelSpecConfigValue[];
  modelRoutes?: readonly ModelRouteConfigValue[];
  budget?: { maxCostMicroUsd: number };
}

export interface ModelCompositionDeps {
  gatewayFactory?: (options: {
    provider: "deepseek" | "glm";
    model: string;
    maxRetries: number;
    requestTimeoutMs: number;
    idleTimeoutMs: number;
    activeStreamTimeoutMs?: number;
  }) => ModelGateway;
}

export interface ModelGateways {
  orchestrator: RoutedModelGateway;
  reviewer: RoutedModelGateway;
  forRole(role: ModelExecutionRole, profile: FrozenAgentProfile | undefined): RoutedModelGateway;
}

const FALLBACK_ON = ["rate_limit", "capacity", "network", "server", "timeout"] as const;
const TOOL_ROLES = new Set<ModelExecutionRole>(["orchestrator", "child_analyze", "child_write"]);

function hasCredential(provider: ModelSpec["providerId"], env: NodeJS.ProcessEnv): boolean {
  if (provider === "deepseek") return Boolean(env.DEEPSEEK_API_KEY?.trim());
  return Boolean(env.GLM_API_KEY?.trim() || env.ZAI_API_KEY?.trim() || env.BIGMODEL_API_KEY?.trim());
}

export function productionModelCandidates(
  config: Pick<ModelCompositionConfig, "provider" | "model" | "legacySingleModelRoute">,
  env: NodeJS.ProcessEnv = process.env
): ModelSpec[] {
  const model = config.model === "auto" ? defaultModel(config.provider, env) : config.model;
  const primary = builtinModelSpec(config.provider, model);
  if (!primary) return [];
  if (config.legacySingleModelRoute) return [primary];
  return [
    primary,
    ...BUILTIN_MODEL_SPECS.filter((spec) => spec.id !== primary.id && hasCredential(spec.providerId, env))
  ];
}

function injectedModelSpec(provider: "deepseek" | "glm", model: string, gateway: ModelGateway): ModelSpec {
  return {
    id: `${provider}/${model}`,
    providerId: provider,
    wireProtocol: "openai_chat",
    upstreamModel: model,
    capabilities: gateway.capabilities,
    tokenizer: { id: "injected/test-tokenizer", accuracy: "approximate" },
    pricing: {
      inputMicroUsdPerMillion: 0,
      outputMicroUsdPerMillion: 0,
      cacheReadMicroUsdPerMillion: 0,
      effectiveAt: "1970-01-01"
    }
  };
}

function configuredSpec(value: ModelSpecConfigValue): ModelSpec {
  return { ...value, wireProtocol: "openai_chat" };
}

function configuredRoute(value: ModelRouteConfigValue): ModelRoute {
  return { ...value };
}

function selectedModel(config: ModelCompositionConfig, env: NodeJS.ProcessEnv): string {
  return config.model === "auto" ? defaultModel(config.provider, env) : config.model;
}

function explicitSpecs(config: ModelCompositionConfig): ModelSpec[] {
  const builtins = new Set(BUILTIN_MODEL_SPECS.map((spec) => spec.id));
  const ids = new Set<string>();
  return (config.modelSpecs ?? []).map((value) => {
    if (builtins.has(value.id)) throw new Error(`Custom model spec '${value.id}' cannot override fixed built-in catalog data.`);
    if (BUILTIN_MODEL_SPECS.some((spec) =>
      spec.providerId === value.providerId && spec.upstreamModel === value.upstreamModel)) {
      throw new Error(`Custom model spec '${value.id}' cannot alias a built-in model with different catalog data.`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate custom model spec id '${value.id}'.`);
    ids.add(value.id);
    if (!value.pricing) {
      throw new Error(`Custom model '${value.id}' requires explicit pricing while a cost cap is enabled.`);
    }
    return configuredSpec(value);
  });
}

function catalog(
  config: ModelCompositionConfig,
  env: NodeJS.ProcessEnv,
  custom: readonly ModelSpec[],
  injected: ModelSpec | undefined
): { primary: ModelSpec; specs: ModelSpec[]; routes: ModelRoute[] } {
  const model = selectedModel(config, env);
  const primary = builtinModelSpec(config.provider, model)
    ?? custom.find((spec) => spec.providerId === config.provider && spec.upstreamModel === model)
    ?? injected;
  if (!primary) {
    throw new Error(`Custom model '${config.provider}/${model}' requires explicit capabilities, tokenizer, and pricing.`);
  }
  const available = new Map<string, ModelSpec>([
    ...BUILTIN_MODEL_SPECS.map((spec) => [spec.id, spec] as const),
    ...custom.map((spec) => [spec.id, spec] as const)
  ]);
  available.set(primary.id, primary);
  const explicitRoutes = (config.modelRoutes ?? []).map(configuredRoute);
  let routes: ModelRoute[];
  if (config.legacySingleModelRoute) {
    routes = [{ id: "default", candidates: [primary.id], fallbackOn: FALLBACK_ON, maxAttempts: 1 }];
  } else if (explicitRoutes.length > 0) {
    routes = explicitRoutes;
  } else {
    const candidates = productionModelCandidates(config, env).map((spec) => spec.id);
    if (!candidates.includes(primary.id)) candidates.unshift(primary.id);
    routes = [{ id: "default", candidates, fallbackOn: FALLBACK_ON, maxAttempts: candidates.length }];
  }
  const referenced = new Set([primary.id, ...routes.flatMap((route) => route.candidates)]);
  const specs = [...referenced].map((id) => available.get(id)).filter((spec): spec is ModelSpec => Boolean(spec));
  return { primary, specs, routes };
}

function constraintsForRole(role: ModelExecutionRole): ModelRouteConstraints {
  return TOOL_ROLES.has(role) ? { requiredCapabilities: { tools: true } } : {};
}

function validateProfileRoutes(router: ModelRouter, customization: RuntimeCustomization): void {
  const profiles = [customization.profile, ...customization.availableProfiles.map((item) => item.profile)];
  for (const profile of profiles) {
    for (const [role, routeId] of Object.entries(profile.profile.roleRoutes)) {
      if (!routeId) continue;
      try {
        router.resolve(routeId, constraintsForRole(role as ModelExecutionRole));
      } catch (error) {
        throw new Error(`Agent Profile '${profile.profile.id}' has unusable ${role} route '${routeId}'.`, { cause: error });
      }
    }
  }
}

export function createRoleGateways(
  config: ModelCompositionConfig,
  deps: ModelCompositionDeps,
  customization: RuntimeCustomization,
  env: NodeJS.ProcessEnv = process.env
): ModelGateways {
  const model = selectedModel(config, env);
  const custom = explicitSpecs(config);
  const knownPrimary = builtinModelSpec(config.provider, model)
    ?? custom.find((spec) => spec.providerId === config.provider && spec.upstreamModel === model);
  if (!knownPrimary && !deps.gatewayFactory) {
    throw new Error(`Custom model '${config.provider}/${model}' requires explicit capabilities, tokenizer, and pricing.`);
  }
  const gatewayOptions = {
    maxRetries: config.maxModelRetries ?? 2,
    requestTimeoutMs: config.modelDeadlineSec * 1_000,
    idleTimeoutMs: config.streamIdleSec * 1_000,
    ...(config.streamActiveSec && config.streamActiveSec > 0
      ? { activeStreamTimeoutMs: config.streamActiveSec * 1_000 } : {})
  };
  const primaryGateway = deps.gatewayFactory?.({ provider: config.provider, model, ...gatewayOptions })
    ?? createModelGatewayForSpec(knownPrimary as ModelSpec, {
      ...gatewayOptions
    });
  const injected = knownPrimary ? undefined : injectedModelSpec(config.provider, model, primaryGateway);
  const resolved = catalog(config, env, custom, injected);
  const gateways = new Map<string, ModelGateway>();
  for (const spec of resolved.specs) {
    const gateway = spec.id === resolved.primary.id
      ? primaryGateway
      : deps.gatewayFactory?.({ provider: spec.providerId, model: spec.upstreamModel, ...gatewayOptions })
        ?? createModelGatewayForSpec(spec, {
          ...gatewayOptions
        });
    gateways.set(spec.id, gateway);
  }
  const router = new ModelRouter(resolved.specs, resolved.routes, (spec) => gateways.get(spec.id) as ModelGateway);
  validateProfileRoutes(router, customization);
  const cache = new Map<string, RoutedModelGateway>();
  const forRole = (role: ModelExecutionRole, profile: FrozenAgentProfile | undefined): RoutedModelGateway => {
    const routeId = profile?.profile.roleRoutes[role] ?? "default";
    const key = `${role}\0${routeId}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const constraints = constraintsForRole(role);
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
