import {
  createHydratedPiModels,
  defaultPiModel,
  listPiAuthStatuses,
  listPiModels,
  listPiProviders,
  piProviderEnvironmentValue,
  PiModelGateway,
  type CredentialStore,
  type Models,
  type ModelsStore,
  type PiReasoningEffort
} from "agent-pi";
import type { ModelCapabilities, ModelGateway } from "agent-protocol";
import {
  builtinModelSpec,
  modelSpecsForPiCatalog,
  type ModelSpec
} from "./catalog.js";
import { classifyModelFailure } from "./failure-policy.js";
import type { ProviderSpi } from "./provider-spi.js";

export type SupportedProvider = string;

export interface CreateGatewayOptions {
  provider: SupportedProvider;
  model?: string;
  baseUrl?: string;
  credentials?: CredentialStore;
  modelsStore?: ModelsStore;
  piModels?: Models;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  activeStreamTimeoutMs?: number;
  capabilities?: ModelCapabilities;
  reasoningEffort?: PiReasoningEffort;
}

export type CreateCatalogGatewayOptions = Omit<CreateGatewayOptions, "provider" | "model">;

export function defaultModel(
  provider: SupportedProvider,
  env: NodeJS.ProcessEnv = process.env
): string {
  return defaultPiModel(provider, env);
}

export function createModelGateway(options: CreateGatewayOptions): ModelGateway {
  const { piModels, ...gatewayOptions } = options;
  const selectedModel = options.model ?? defaultModel(options.provider);
  const spec = builtinModelSpec(options.provider, selectedModel);
  const baseUrl = options.baseUrl
    ?? piProviderEnvironmentValue(options.provider, "BASE_URL");
  return new PiModelGateway({
    ...gatewayOptions,
    model: selectedModel,
    ...(baseUrl ? { baseUrl } : {}),
    ...(piModels ? { models: piModels } : {}),
    capabilities: options.capabilities ?? spec?.capabilities
  });
}

export function createModelGatewayForSpec(
  spec: ModelSpec,
  options: CreateCatalogGatewayOptions = {}
): ModelGateway {
  return createModelGateway({
    ...options,
    provider: spec.providerId,
    model: spec.upstreamModel,
    capabilities: spec.capabilities
  });
}

const defaultCapabilities: ModelCapabilities = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  tools: true,
  parallelTools: false,
  reasoning: true,
  structuredOutput: false,
  promptCache: false,
  tokenizer: "approximate"
};

export function providerAdapter(provider: SupportedProvider): ProviderSpi {
  return {
    id: provider,
    defaultModel: (env) => defaultPiModel(provider, env),
    capabilities: (spec) => spec?.capabilities ?? defaultCapabilities,
    prepare: (options, model, spec) => new PiModelGateway({
      ...options,
      provider,
      model,
      capabilities: spec?.capabilities
    }),
    stream: (gateway, request) => gateway.stream(request),
    cancel: (controller, reason) => controller.abort(reason),
    normalizeUsage: (usage) => ({ ...usage }),
    classifyError: classifyModelFailure
  };
}

export interface PiRuntimeModelCatalog {
  specs: readonly ModelSpec[];
  authenticatedProviders: ReadonlySet<string>;
  gatewayFactory(options: {
    provider: string;
    model: string;
    maxRetries: number;
    requestTimeoutMs: number;
    idleTimeoutMs: number;
    activeStreamTimeoutMs?: number;
    reasoningEffort?: PiReasoningEffort;
  }): ModelGateway;
}

export async function loadPiRuntimeModelCatalog(options: {
  credentials?: CredentialStore;
  modelsStore?: ModelsStore;
} = {}): Promise<PiRuntimeModelCatalog> {
  const piModels = await createHydratedPiModels(
    options.credentials,
    options.modelsStore
  );
  const [statuses] = await Promise.all([
    listPiAuthStatuses(options.credentials)
  ]);
  const providers = new Map(listPiProviders(piModels).map((provider) => [provider.id, provider]));
  const activeBillingModes = new Map(statuses.flatMap((status) => {
    if (status.status !== "authenticated" || !status.authType) return [];
    const method = providers.get(status.provider)?.authMethods.find(
      (candidate) => candidate.kind === status.authType
    );
    return method ? [[status.provider, method.billingMode] as const] : [];
  }));
  const authenticatedProviders = new Set(statuses.flatMap((status) =>
    status.status === "authenticated" ? [status.provider] : []));
  const specs = modelSpecsForPiCatalog(listPiModels(piModels), activeBillingModes);
  return {
    specs,
    authenticatedProviders,
    gatewayFactory: (options) => {
      const { maxRetries: _policyRetries, ...transport } = options;
      void _policyRetries;
      return createModelGateway({ ...transport, piModels });
    }
  };
}
