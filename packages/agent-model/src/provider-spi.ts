import type {
  ModelCapabilities,
  ModelGateway,
  ModelRequest,
  ModelResponseUsage,
  ModelStreamEvent
} from "agent-protocol";
import type { ModelFailureCategory, ModelSpec } from "./catalog.js";
import type { CreateGatewayOptions, SupportedProvider } from "./registry.js";

/** Provider boundary owned by agent-model. Runtime/session code consumes only
 * ModelGateway and never branches on a provider id. */
export interface ProviderSpiV1 {
  readonly id: SupportedProvider;
  defaultModel(env: NodeJS.ProcessEnv): string;
  capabilities(spec?: ModelSpec): ModelCapabilities;
  prepare(options: CreateGatewayOptions, model: string, spec?: ModelSpec): ModelGateway;
  stream(gateway: ModelGateway, request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  cancel(controller: AbortController, reason?: unknown): void;
  normalizeUsage(usage: ModelResponseUsage): ModelResponseUsage;
  classifyError(error: unknown): ModelFailureCategory;
}
