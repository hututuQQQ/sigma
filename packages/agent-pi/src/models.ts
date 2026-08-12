import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type AuthType,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
  type ModelsStore,
  type MutableModels,
  type Provider
} from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import {
  builtinProviders,
  getBuiltinModelDataGeneratedAt
} from "@earendil-works/pi-ai/providers/all";
import type { ModelCapabilities } from "agent-protocol";
import { defaultCredentialStore } from "./credential-bridge.js";
import { piModelPricing, type PiModelPricing } from "./model-pricing.js";
import {
  DEFAULT_PI_REASONING_EFFORT,
  piBillingMode,
  providerAuthMethods,
  supportedReasoningEfforts,
  type PiModelDescriptor,
  type PiProviderDescriptor
} from "./model-descriptors.js";
import { sanitizePiModelError } from "./errors.js";
import { FileModelsStore } from "./models-store.js";

export type { PiModelPricing, PiModelPricingTier } from "./model-pricing.js";
export {
  DEFAULT_PI_REASONING_EFFORT,
  PI_REASONING_EFFORTS,
  piBillingMode,
  type PiAuthMethodDescriptor,
  type PiBillingMode,
  type PiModelDescriptor,
  type PiProviderDescriptor,
  type PiReasoningEffort
} from "./model-descriptors.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-5.6-terra" as const;
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api" as const;
export const GLM_PROVIDER_ID = "glm" as const;
export const GLM_DEFAULT_MODEL = "glm-5.2" as const;
export const PI_AI_VERSION = "0.82.1" as const;

const generatedAt = getBuiltinModelDataGeneratedAt();
const catalogEffectiveAt = generatedAt === undefined
  ? "2026-07-30"
  : new Date(generatedAt).toISOString().slice(0, 10);

const recommendedModels = new Set<string>([
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
  "deepseek/deepseek-v4-pro",
  "glm/glm-5.2"
]);

const glmModel: Model<"openai-completions"> = {
  id: GLM_DEFAULT_MODEL,
  name: "GLM 5.2",
  api: "openai-completions",
  provider: GLM_PROVIDER_ID,
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 1.12,
    output: 3.92,
    cacheRead: 0.28,
    cacheWrite: 1.12
  },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  compat: {
    supportsDeveloperRole: false,
    thinkingFormat: "zai",
    zaiToolStream: true
  }
};

function glmProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: GLM_PROVIDER_ID,
    name: "GLM",
    baseUrl: glmModel.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("GLM API key", [
        "GLM_API_KEY",
        "ZAI_API_KEY",
        "BIGMODEL_API_KEY"
      ])
    },
    models: [glmModel],
    api: openAICompletionsApi
  });
}

function freshProviders(): Provider[] {
  return [...builtinProviders(), glmProvider()];
}

function pricing(model: Model<Api>): PiModelPricing | undefined {
  return piModelPricing(model, catalogEffectiveAt);
}

export function piHostedToolSearchSupported(model: Model<Api>): boolean {
  const responsesTransport = model.api === "openai-responses"
    || model.api === "openai-codex-responses"
    || model.api === "azure-openai-responses";
  const compat = model.compat as { supportsToolSearch?: boolean } | undefined;
  return responsesTransport && compat?.supportsToolSearch === true;
}

function capabilities(model: Model<Api>): ModelCapabilities {
  const strictToolChoice = model.api === "openai-completions"
    || model.api === "openai-responses"
    || model.api === "openai-codex-responses"
    || model.api === "anthropic-messages";
  return {
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    tools: true,
    parallelTools: true,
    reasoning: model.reasoning,
    structuredOutput: model.api === "openai-responses"
      || model.api === "openai-codex-responses",
    promptCache: true,
    tokenizer: "approximate",
    imageInput: model.input.includes("image"),
    hostedToolSearch: piHostedToolSearchSupported(model),
    ...(strictToolChoice ? { strictToolChoice: true } : {})
  };
}

export function createPiModels(
  credentials: CredentialStore = defaultCredentialStore(),
  modelsStore: ModelsStore = new FileModelsStore()
): MutableModels {
  const models = createModels({ credentials, modelsStore });
  for (const provider of freshProviders()) models.setProvider(provider);
  return models;
}

export async function createHydratedPiModels(
  credentials: CredentialStore = defaultCredentialStore(),
  modelsStore: ModelsStore = new FileModelsStore()
): Promise<Models> {
  const models = createPiModels(credentials, modelsStore);
  await hydratePiModelCache(models, credentials, modelsStore);
  return models;
}

export async function hydratePiModelCache(
  models: Models,
  credentials: CredentialStore = defaultCredentialStore(),
  modelsStore: ModelsStore = new FileModelsStore()
): Promise<void> {
  for (const provider of models.getProviders()) {
    if (!provider.refreshModels) continue;
    const scopedStore = {
      read: () => modelsStore.read(provider.id),
      write: (entry: Parameters<ModelsStore["write"]>[1]) => modelsStore.write(provider.id, entry),
      delete: () => modelsStore.delete(provider.id)
    };
    await provider.refreshModels({
      credential: await credentials.read(provider.id),
      store: scopedStore,
      allowNetwork: false
    });
  }
}

function safeOAuthRefreshError(error: unknown, providerId: string): Error {
  const safe = sanitizePiModelError(error);
  safe.message = `OAuth refresh failed for provider '${providerId}'. Sign in again and retry.`;
  return safe;
}

export async function refreshPiProviderModels(
  models: Models,
  providerId: string,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    credentials?: CredentialStore;
    modelsStore?: ModelsStore;
  } = {}
): Promise<void> {
  const provider = models.getProvider(providerId);
  if (!provider) throw new Error(`Unknown Pi provider '${providerId}'.`);
  if (!provider.refreshModels) return;
  const credentials = options.credentials ?? defaultCredentialStore();
  const modelsStore = options.modelsStore ?? new FileModelsStore();
  let storedCredential: Credential | undefined;
  try {
    storedCredential = await credentials.read(providerId);
  } catch (error) {
    throw sanitizePiModelError(error);
  }
  const targeted = createModels({ credentials, modelsStore });
  targeted.setProvider(provider);
  let auth: Awaited<ReturnType<Models["getAuth"]>>;
  try {
    auth = await targeted.getAuth(providerId);
  } catch (error) {
    if (storedCredential?.type === "oauth") {
      throw safeOAuthRefreshError(error, providerId);
    }
    throw sanitizePiModelError(error);
  }
  if (!auth) {
    throw new Error(`Provider '${providerId}' has no configured authentication.`);
  }
  const result = await targeted.refresh({
    allowNetwork: true,
    force: options.force ?? true,
    ...(options.signal ? { signal: options.signal } : {})
  });
  const error = result.errors.get(providerId);
  if (error) throw sanitizePiModelError(error);
}

export function listPiProviders(models: Models = createPiModels()): readonly PiProviderDescriptor[] {
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    dynamic: Boolean(provider.refreshModels),
    authMethods: providerAuthMethods(provider)
  }));
}

export function listPiModels(models: Models = createPiModels()): readonly PiModelDescriptor[] {
  const providers = new Map(models.getProviders().map((provider) => [provider.id, provider]));
  return models.getModels().map((model) => {
    const provider = providers.get(model.provider);
    const authTypes: AuthType[] = [
      ...(provider?.auth.apiKey ? ["api_key" as const] : []),
      ...(provider?.auth.oauth ? ["oauth" as const] : [])
    ];
    const billingModes = [...new Set(authTypes.map((type) =>
      piBillingMode(model.provider, type, model)))];
    const modelPricing = pricing(model);
    const reasoningEfforts = supportedReasoningEfforts(model);
    const defaultReasoningEffort = reasoningEfforts.includes(DEFAULT_PI_REASONING_EFFORT)
      ? DEFAULT_PI_REASONING_EFFORT
      : reasoningEfforts[0];
    return {
      id: model.id,
      name: model.name,
      providerId: model.provider,
      providerName: provider?.name ?? model.provider,
      api: model.api,
      contextWindowTokens: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      reasoning: model.reasoning,
      imageInput: model.input.includes("image"),
      capabilities: capabilities(model),
      billingModes,
      ...(modelPricing ? { pricing: modelPricing } : {}),
      recommended: recommendedModels.has(`${model.provider}/${model.id}`),
      supportedReasoningEfforts: reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {})
    };
  });
}

export function getPiModel(
  providerId: string,
  modelId: string,
  models: Models = createPiModels()
): Model<Api> | undefined {
  return models.getModel(providerId, modelId);
}

export function getPiProvider(
  providerId: string,
  models: Models = createPiModels()
): Provider | undefined {
  return models.getProvider(providerId);
}

export function defaultPiModel(providerId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (providerId === OPENAI_CODEX_PROVIDER_ID) return OPENAI_CODEX_DEFAULT_MODEL;
  if (providerId === "deepseek") return env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
  if (providerId === GLM_PROVIDER_ID) return env.GLM_MODEL ?? GLM_DEFAULT_MODEL;
  const provider = getPiProvider(providerId);
  const first = provider?.getModels()[0];
  if (!first) throw new Error(`Provider '${providerId}' has no available models.`);
  return first.id;
}

export function getOpenAICodexPiModel(
  modelId: string
): Model<"openai-codex-responses"> | undefined {
  const model = getPiModel(OPENAI_CODEX_PROVIDER_ID, modelId);
  return model?.api === "openai-codex-responses"
    ? model as Model<"openai-codex-responses">
    : undefined;
}

export function listOpenAICodexModels(): readonly PiModelDescriptor[] {
  return listPiModels().filter((model) => model.providerId === OPENAI_CODEX_PROVIDER_ID);
}

export function createOpenAICodexModels(credentials: CredentialStore): Models {
  const models = createModels({ credentials });
  const provider = freshProviders().find((candidate) =>
    candidate.id === OPENAI_CODEX_PROVIDER_ID);
  if (provider) models.setProvider(provider);
  return models;
}
