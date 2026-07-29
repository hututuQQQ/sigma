import {
  createModels,
  type CredentialStore,
  type Model,
  type Models
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-5.6-terra" as const;
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api" as const;

export interface OpenAICodexModelDescriptor {
  id: string;
  name: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  reasoning: boolean;
  imageInput: boolean;
}

const provider = openaiCodexProvider();

export function listOpenAICodexModels(): readonly OpenAICodexModelDescriptor[] {
  return provider.getModels().map((model) => ({
    id: model.id,
    name: model.name,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning,
    imageInput: model.input.includes("image")
  }));
}

export function getOpenAICodexPiModel(modelId: string): Model<"openai-codex-responses"> | undefined {
  return provider.getModels().find((model) => model.id === modelId);
}

export function createOpenAICodexModels(credentials: CredentialStore): Models {
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  return models;
}
