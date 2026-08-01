import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { ModelReasoningEffort } from "agent-model";
import type { ModelImage, RunMode, RunOutcome, RuntimeClient } from "agent-protocol";

export const MODEL_CONFIG_ID = "sigma.model";
export const REASONING_EFFORT_CONFIG_ID = "sigma.reasoning_effort";
export const SIGMA_RUNTIME_REQUEST_ERROR = -32001;

export interface SigmaAcpRuntimeHandle {
  runtime: RuntimeClient;
  workspace: string;
  storeRootDir: string;
  close(): Promise<void>;
}

export interface SigmaAcpModelOption {
  id: string;
  name: string;
  description?: string;
  supportedReasoningEfforts?: readonly ModelReasoningEffort[];
  defaultReasoningEffort?: ModelReasoningEffort;
  imageInput?: boolean;
}

export interface SigmaAcpModelCatalog {
  currentModelId: string;
  options: SigmaAcpModelOption[];
}

export interface SigmaAcpSkill {
  name: string;
  qualifiedName: string;
  description: string;
  source: "home" | "workspace";
  path: string;
}

export interface SigmaAcpAgentOptions {
  agentVersion: string;
  runtimeFactory(
    cwd: string,
    modelId: string,
    reasoningEffort?: ModelReasoningEffort,
    mcpServers?: readonly acp.McpServer[]
  ): Promise<SigmaAcpRuntimeHandle>;
  modelCatalog(cwd: string): Promise<SigmaAcpModelCatalog>;
  skillCatalog?(cwd: string): Promise<readonly SigmaAcpSkill[]>;
  stderr?: NodeJS.WritableStream;
}

export interface PersistedAcpSession {
  sessionId: string;
  runtimeSessionId: string;
  cwd: string;
  modelId: string;
  reasoningEffort?: ModelReasoningEffort;
  mode: RunMode;
  title?: string;
  createdAt: string;
  updatedAt: string;
  started: boolean;
  lastSeq: number;
}

export interface ResolvedSession {
  record: PersistedAcpSession;
  handle: SigmaAcpRuntimeHandle;
}

export interface ForwardState {
  modelText: Map<number, string>;
  reasoningText: Map<number, string>;
  userInputContinuation?: Promise<boolean>;
}

export interface SigmaTextCommand {
  sessionId: string;
  text: string;
}

export interface SigmaRollbackCommand {
  sessionId: string;
  numTurns: number;
}

export interface SigmaCapabilitiesRequest {
  cwd: string;
}

export interface SigmaSessionRequest {
  sessionId: string;
}

export interface SigmaPromptContent {
  text: string;
  images: ModelImage[];
}

const MAX_PROMPT_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;
const MAX_TOTAL_IMAGE_BYTES = MAX_PROMPT_IMAGES * MAX_IMAGE_BYTES;

export function parseSigmaTextCommand(value: unknown): SigmaTextCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sigma ACP command params must be an object.");
  }
  const params = value as Record<string, unknown>;
  if (typeof params.sessionId !== "string" || !params.sessionId) {
    throw new Error("Sigma ACP command requires sessionId.");
  }
  if (typeof params.text !== "string" || !params.text) {
    throw new Error("Sigma ACP command requires text.");
  }
  return { sessionId: params.sessionId, text: params.text };
}

export function parseSigmaRollbackCommand(value: unknown): SigmaRollbackCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sigma ACP rollback params must be an object.");
  }
  const params = value as Record<string, unknown>;
  if (typeof params.sessionId !== "string" || !params.sessionId) {
    throw new Error("Sigma ACP rollback requires sessionId.");
  }
  if (!Number.isInteger(params.numTurns) || Number(params.numTurns) < 1) {
    throw new Error("Sigma ACP rollback requires numTurns to be an integer >= 1.");
  }
  return { sessionId: params.sessionId, numTurns: Number(params.numTurns) };
}

export function parseSigmaCapabilitiesRequest(value: unknown): SigmaCapabilitiesRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sigma ACP capabilities params must be an object.");
  }
  const params = value as Record<string, unknown>;
  if (typeof params.cwd !== "string" || !params.cwd.trim()) {
    throw new Error("Sigma ACP capabilities requires cwd.");
  }
  return { cwd: path.resolve(params.cwd) };
}

export function parseSigmaSessionRequest(value: unknown): SigmaSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sigma ACP session request params must be an object.");
  }
  const params = value as Record<string, unknown>;
  if (typeof params.sessionId !== "string" || !params.sessionId) {
    throw new Error("Sigma ACP session request requires sessionId.");
  }
  return { sessionId: params.sessionId };
}

export function parseHealthRequest(value: unknown): Record<string, never> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new Error("Sigma ACP health params must be empty.");
  }
  return {};
}

export function sessionModes(mode: RunMode): acp.SessionModeState {
  return {
    currentModeId: mode,
    availableModes: [
      { id: "change", name: "Agent", description: "Analyze and modify the workspace." },
      { id: "analyze", name: "Plan", description: "Analyze the workspace without writes." }
    ]
  };
}

export function modelConfig(
  catalog: SigmaAcpModelCatalog,
  currentModelId: string,
  currentReasoningEffort?: ModelReasoningEffort
): acp.SessionConfigOption[] {
  const options: acp.SessionConfigOption[] = [{
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "Model used by Sigma Runtime.",
    category: "model",
    type: "select",
    currentValue: currentModelId,
    options: catalog.options.map((option) => ({
      value: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {})
    }))
  }];
  const model = catalog.options.find((option) => option.id === currentModelId);
  const supported = model?.supportedReasoningEfforts ?? [];
  const reasoningEffort = reasoningEffortForModel(
    catalog,
    currentModelId,
    currentReasoningEffort
  );
  if (supported.length > 0 && reasoningEffort) {
    const labels: Record<ModelReasoningEffort, string> = {
      none: "None",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
      max: "Max"
    };
    options.push({
      id: REASONING_EFFORT_CONFIG_ID,
      name: "Reasoning",
      description: "Reasoning effort used by Sigma Runtime for this model.",
      category: "thought_level",
      type: "select",
      currentValue: reasoningEffort,
      options: supported.map((effort) => ({
        value: effort,
        name: labels[effort]
      }))
    });
  }
  return options;
}

export function reasoningEffortForModel(
  catalog: SigmaAcpModelCatalog,
  modelId: string,
  requested?: ModelReasoningEffort
): ModelReasoningEffort | undefined {
  const model = catalog.options.find((option) => option.id === modelId);
  const supported = model?.supportedReasoningEfforts ?? [];
  if (requested && supported.includes(requested)) return requested;
  if (model?.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return supported[0];
}

export function promptContent(prompt: acp.ContentBlock[]): SigmaPromptContent {
  const unsupported = prompt.find((block) => block.type !== "text" && block.type !== "image");
  if (unsupported) {
    throw new Error(`Sigma ACP accepts text and image prompts; received '${unsupported.type}'.`);
  }
  const text = prompt.map((block) => block.type === "text" ? block.text : "").join("");
  const imageBlocks = prompt.filter((block): block is acp.ImageContent & { type: "image" } =>
    block.type === "image");
  if (imageBlocks.length > MAX_PROMPT_IMAGES) {
    throw new Error(`Sigma ACP accepts at most ${MAX_PROMPT_IMAGES} images per prompt.`);
  }
  let totalBytes = 0;
  const images = imageBlocks.map((block, index): ModelImage => {
    if (!/^image\/[a-z0-9.+-]+$/iu.test(block.mimeType)) {
      throw new Error(`Sigma ACP image ${index + 1} has an invalid MIME type.`);
    }
    if (!/^[a-z0-9+/]*={0,2}$/iu.test(block.data) || block.data.length % 4 === 1) {
      throw new Error(`Sigma ACP image ${index + 1} is not valid base64 data.`);
    }
    const sizeBytes = Buffer.from(block.data, "base64").byteLength;
    if (sizeBytes === 0 || sizeBytes > MAX_IMAGE_BYTES) {
      throw new Error(`Sigma ACP image ${index + 1} must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
    }
    totalBytes += sizeBytes;
    return { data: block.data, mimeType: block.mimeType };
  });
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(`Sigma ACP prompt images exceed the ${MAX_TOTAL_IMAGE_BYTES} byte total limit.`);
  }
  if (!text && images.length === 0) throw new Error("Sigma ACP prompt must not be empty.");
  return { text, images };
}

export function titleFromPrompt(text: string): string {
  const firstLine = text.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
}

export function listOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^sigma:(0|[1-9]\d*)$/u.exec(cursor);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset)) throw new Error(`Invalid Sigma session cursor '${cursor}'.`);
  return offset;
}

export function promptResponseForOutcome(outcome: RunOutcome): acp.PromptResponse {
  if (outcome.kind === "fatal" || outcome.kind === "recoverable_failure") {
    throw new acp.RequestError(SIGMA_RUNTIME_REQUEST_ERROR, outcome.message, {
      "sigma.outcome": outcome.kind,
      "sigma.code": outcome.code
    });
  }
  return {
    stopReason: outcome.kind === "cancelled" ? "cancelled" : "end_turn",
    _meta: {
      "sigma.outcome": outcome.kind,
      ...(outcome.kind === "cancelled"
        ? { "sigma.message": outcome.reason }
        : { "sigma.message": outcome.message })
    }
  };
}

export function expectedAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  return error === signal.reason
    || (error instanceof Error && (error.name === "AbortError" || /cancel|abort/iu.test(error.message)));
}
