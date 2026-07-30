import {
  createHydratedPiModels,
  defaultPiModel,
  listPiAuthStatuses,
  listPiModels,
  listPiProviders,
  PiModelGateway,
  type CredentialStore,
  type Models,
  type ModelsStore
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
    ?? (options.provider === "deepseek" ? process.env.DEEPSEEK_BASE_URL : undefined)
    ?? (options.provider === "glm"
      ? process.env.GLM_BASE_URL ?? process.env.ZAI_BASE_URL ?? process.env.BIGMODEL_BASE_URL
      : undefined);
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
  gatewayFactory(options: {
    provider: string;
    model: string;
    maxRetries: number;
    requestTimeoutMs: number;
    idleTimeoutMs: number;
    activeStreamTimeoutMs?: number;
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
  const specs = modelSpecsForPiCatalog(listPiModels(piModels), activeBillingModes);
  return {
    specs,
    gatewayFactory: (options) => {
      const { maxRetries: _policyRetries, ...transport } = options;
      void _policyRetries;
      return createModelGateway({ ...transport, piModels });
    }
  };
}
