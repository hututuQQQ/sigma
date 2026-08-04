import { randomUUID } from "node:crypto";
import {
  cleanupSessionResources,
  type Api,
  type CredentialStore,
  type Model as PiModel,
  type Models,
  type ModelsStore
} from "@earendil-works/pi-ai";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "agent-protocol";
import { codexPayload } from "./codex-instructions.js";
import { defaultCredentialStore } from "./credential-bridge.js";
import {
  PiModelError,
  sanitizePiModelError,
  type PiModelErrorDiagnostics
} from "./errors.js";
import {
  approximateModelInputTokens,
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
import { hasKnownPricing } from "./model-pricing.js";
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

interface PiStreamLifecycle {
  doneReceived: boolean;
  transportEnded: boolean;
  lastEventType: string;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCall: boolean;
}

function newPiStreamLifecycle(): PiStreamLifecycle {
  return {
    doneReceived: false,
    transportEnded: false,
    lastEventType: "none",
    hasContent: false,
    hasReasoning: false,
    hasToolCall: false
  };
}

function piSamplingOptions(
  capabilities: ModelCapabilities,
  request: ModelRequest
): Partial<Pick<ModelRequest, "temperature">> {
  return capabilities.temperatureControl === false || request.temperature === undefined
    ? {}
    : { temperature: request.temperature };
}

function observePiStreamEvent(
  lifecycle: PiStreamLifecycle,
  event: ModelStreamEvent
): void {
  lifecycle.lastEventType = event.type;
  if (event.type === "content") lifecycle.hasContent = true;
  if (event.type === "reasoning") lifecycle.hasReasoning = true;
  if (event.type === "tool_call") lifecycle.hasToolCall = true;
  if (event.type === "done") lifecycle.doneReceived = true;
}

function streamFailureDiagnostics(
  provider: string,
  model: string,
  lifecycle: PiStreamLifecycle,
  startedAt: number,
  responseStatus: number | undefined
): PiModelErrorDiagnostics {
  return {
    provider,
    model,
    ...(responseStatus !== undefined && responseStatus >= 400
      ? { httpStatus: responseStatus }
      : {}),
    totalDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    doneReceived: lifecycle.doneReceived,
    ...(lifecycle.transportEnded ? { transportEnded: true } : {}),
    lastEventType: lifecycle.lastEventType,
    hasContent: lifecycle.hasContent,
    hasReasoning: lifecycle.hasReasoning,
    hasToolCall: lifecycle.hasToolCall
  };
}

function sanitizedStreamFailure(
  error: unknown,
  signal: ModelRequest["signal"],
  provider: string,
  model: string,
  lifecycle: PiStreamLifecycle,
  startedAt: number,
  responseStatus: number | undefined
): PiModelError {
  signal.throwIfAborted();
  const statusAwareError = responseStatus === undefined
    || (error && typeof error === "object" && "status" in error)
    ? error
    : Object.assign(
        error instanceof Error ? error : new Error("Provider request failed."),
        { status: responseStatus }
      );
  return sanitizePiModelError(
    statusAwareError,
    streamFailureDiagnostics(provider, model, lifecycle, startedAt, responseStatus)
  );
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
  private readonly hasKnownCatalogPrice: boolean;
  private readonly codexInstructionNonce = randomUUID();

  constructor(options: PiModelGatewayOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.models = options.models ?? createPiModels(
      options.credentials ?? defaultCredentialStore(),
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
    this.hasKnownCatalogPrice = hasKnownPricing(this.piModel);
    const capabilities = options.capabilities ?? {
      contextWindowTokens: piModel.contextWindow,
      maxOutputTokens: piModel.maxTokens,
      tools: true,
      parallelTools: true,
      reasoning: piModel.reasoning,
      structuredOutput: piModel.api === "openai-responses"
        || piModel.api === "openai-codex-responses",
      promptCache: true,
      tokenizer: "approximate",
      imageInput: piModel.input.includes("image")
    };
    this.capabilities = {
      ...capabilities,
      temperatureControl: options.capabilities?.temperatureControl
        ?? piModel.api !== "openai-codex-responses"
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
    const lifecycle = newPiStreamLifecycle();
    try {
      const stream = monitoredPiStream((signal) => {
        const context = piContext(request, this.piModel, this.codexInstructionNonce);
        const options = {
          signal,
          maxTokens: request.maxOutputTokens,
          ...piSamplingOptions(this.capabilities, request),
          toolChoice: request.toolChoice,
          maxRetries: 0,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(this.provider === OPENAI_CODEX_PROVIDER_ID ? { transport: "auto" as const } : {}),
          ...piReasoningStreamOptions(
            this.piModel,
            this.reasoningEffort,
            context,
            request.maxOutputTokens
          ),
          ...(this.requestTimeoutMs ? { timeoutMs: this.requestTimeoutMs } : {}),
          ...(this.provider === OPENAI_CODEX_PROVIDER_ID
            ? {
                onPayload: (payload: unknown) =>
                  codexPayload(payload, this.codexInstructionNonce)
              }
            : this.provider === "deepseek"
              ? { onPayload: (payload: unknown) => deepSeekPayload(payload, request) }
              : {}),
          onResponse: (response: { status: number }) => {
            responseStatus = response.status;
          }
        };
        return this.models.stream(this.piModel, context, options as never);
      }, {
        signal: request.signal,
        ...(this.requestTimeoutMs === undefined
          ? {}
          : { initialTimeoutMs: this.requestTimeoutMs }),
        idleTimeoutMs: this.idleTimeoutMs,
        ...(this.activeStreamTimeoutMs === undefined
          ? {}
          : { activeTimeoutMs: this.activeStreamTimeoutMs })
      });
      for await (const event of stream) {
        const mapped = mapPiStreamEvent(
          event, toolIndex, startedAt, billingMode, responseStatus, this.hasKnownCatalogPrice
        );
        toolIndex = mapped.nextToolIndex;
        if (mapped.error) {
          lifecycle.lastEventType = "error";
          request.signal.throwIfAborted();
          throw mapped.error;
        }
        for (const output of mapped.events) {
          observePiStreamEvent(lifecycle, output);
          yield output;
        }
        if (mapped.done) return;
      }
      lifecycle.transportEnded = true;
      throw new PiModelError("network", "network");
    } catch (error) {
      throw sanitizedStreamFailure(
        error,
        request.signal,
        this.provider,
        this.model,
        lifecycle,
        startedAt,
        responseStatus
      );
    }
  }

  async countTokens(messages: ModelMessage[], tools = []): Promise<number> {
    return approximateModelInputTokens(messages, tools);
  }

  releaseSession(sessionId: string): void {
    cleanupSessionResources(sessionId);
  }
}
