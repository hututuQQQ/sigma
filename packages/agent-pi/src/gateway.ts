import type {
  Api,
  CredentialStore,
  Model as PiModel,
  Models,
  ModelsStore
} from "@earendil-works/pi-ai";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "agent-protocol";
import { FileCredentialStore } from "./credential-store.js";
import { PiModelError, sanitizePiModelError } from "./errors.js";
import {
  approximateTokens,
  deepSeekPayload,
  mapPiStreamEvent,
  piContext
} from "./gateway-adapter.js";
import {
  createPiModels,
  getPiModel,
  getPiProvider,
  OPENAI_CODEX_PROVIDER_ID,
  piBillingMode,
  type PiReasoningEffort
} from "./models.js";
import { FileModelsStore } from "./models-store.js";
import { piReasoningStreamOptions } from "./reasoning.js";
import { monitoredPiStream } from "./stream-timeout.js";

export interface PiModelGatewayOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  credentials?: CredentialStore;
  modelsStore?: ModelsStore;
  models?: Models;
  capabilities?: ModelCapabilities;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  activeStreamTimeoutMs?: number;
  reasoningEffort?: PiReasoningEffort;
}

function fallbackModel(providerId: string, modelId: string): PiModel<Api> | undefined {
  if (providerId !== "deepseek" && providerId !== "glm") return undefined;
  const template = getPiProvider(providerId)?.getModels()[0];
  return template
    ? { ...template, id: modelId, name: modelId }
    : undefined;
}

export class PiModelGateway implements ModelGateway {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  private readonly models: Models;
  private readonly piModel: PiModel<Api>;
  private readonly requestTimeoutMs?: number;
  private readonly idleTimeoutMs: number;
  private readonly activeStreamTimeoutMs?: number;
  private readonly reasoningEffort?: PiReasoningEffort;

  constructor(options: PiModelGatewayOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.models = options.models ?? createPiModels(
      options.credentials ?? new FileCredentialStore(),
      options.modelsStore ?? new FileModelsStore()
    );
    const piModel = getPiModel(options.provider, options.model, this.models)
      ?? fallbackModel(options.provider, options.model);
    if (!piModel) throw new PiModelError("protocol", "protocol");
    this.piModel = options.baseUrl
      ? { ...piModel, baseUrl: options.baseUrl.replace(/\/+$/u, "") }
      : piModel;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.idleTimeoutMs = Math.max(1, Math.trunc(options.idleTimeoutMs ?? 45_000));
    this.activeStreamTimeoutMs = options.activeStreamTimeoutMs === undefined
      ? undefined
      : Math.max(1, Math.trunc(options.activeStreamTimeoutMs));
    this.reasoningEffort = options.reasoningEffort;
    this.capabilities = options.capabilities ?? {
      contextWindowTokens: piModel.contextWindow,
      maxOutputTokens: piModel.maxTokens,
      tools: true,
      parallelTools: true,
      reasoning: piModel.reasoning,
      structuredOutput: piModel.api === "openai-responses"
        || piModel.api === "openai-codex-responses",
      promptCache: true,
      tokenizer: "approximate"
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    for await (const event of this.stream(request)) {
      if (event.type === "done") return event.response;
    }
    throw new PiModelError("protocol", "protocol");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const startedAt = performance.now();
    const auth = await this.models.checkAuth(this.provider);
    if (!auth) throw new PiModelError("auth_required", "auth");
    const billingMode = piBillingMode(this.provider, auth.type, this.piModel);
    let toolIndex = 0;
    let responseStatus: number | undefined;
    try {
      const stream = monitoredPiStream((signal) => {
        const context = piContext(request, this.piModel);
        const options = {
          signal,
          maxTokens: request.maxOutputTokens,
          temperature: request.temperature,
          toolChoice: request.toolChoice,
          maxRetries: 0,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(this.provider === OPENAI_CODEX_PROVIDER_ID ? { transport: "sse" as const } : {}),
          ...piReasoningStreamOptions(
            this.piModel,
            this.reasoningEffort,
            context,
            request.maxOutputTokens
          ),
          ...(this.requestTimeoutMs ? { timeoutMs: this.requestTimeoutMs } : {}),
          ...(this.provider === "deepseek"
            ? { onPayload: (payload: unknown) => deepSeekPayload(payload, request) }
            : {}),
          onResponse: (response: { status: number }) => {
            responseStatus = response.status;
          }
        };
        return this.models.stream(
          this.piModel,
          context,
          options as never
        );
      }, {
        signal: request.signal,
        idleTimeoutMs: this.idleTimeoutMs,
        ...(this.activeStreamTimeoutMs === undefined
          ? {}
          : { activeTimeoutMs: this.activeStreamTimeoutMs })
      });
      for await (const event of stream) {
        const mapped = mapPiStreamEvent(
          event,
          toolIndex,
          startedAt,
          billingMode,
          responseStatus
        );
        toolIndex = mapped.nextToolIndex;
        if (mapped.error) {
          request.signal.throwIfAborted();
          throw mapped.error;
        }
        for (const output of mapped.events) yield output;
        if (mapped.done) return;
      }
      throw new PiModelError("protocol", "protocol");
    } catch (error) {
      request.signal.throwIfAborted();
      throw sanitizePiModelError(
        responseStatus === undefined || (error && typeof error === "object" && "status" in error)
          ? error
          : Object.assign(
              error instanceof Error ? error : new Error("Provider request failed."),
              { status: responseStatus }
            )
      );
    }
  }

  async countTokens(messages: ModelMessage[], tools = []): Promise<number> {
    return approximateTokens({ messages, tools });
  }
}
