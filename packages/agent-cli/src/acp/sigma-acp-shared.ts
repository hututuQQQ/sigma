import * as acp from "@agentclientprotocol/sdk";
import type { RunMode, RunOutcome, RuntimeClient } from "agent-protocol";

export const MODEL_CONFIG_ID = "sigma.model";

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
}

export interface SigmaAcpModelCatalog {
  currentModelId: string;
  options: SigmaAcpModelOption[];
}

export interface SigmaAcpAgentOptions {
  agentVersion: string;
  runtimeFactory(cwd: string, modelId: string): Promise<SigmaAcpRuntimeHandle>;
  modelCatalog(cwd: string): Promise<SigmaAcpModelCatalog>;
  stderr?: NodeJS.WritableStream;
}

export interface PersistedAcpSession {
  sessionId: string;
  runtimeSessionId: string;
  cwd: string;
  modelId: string;
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
}

export interface SigmaTextCommand {
  sessionId: string;
  text: string;
}

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
  currentModelId: string
): acp.SessionConfigOption[] {
  return [{
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
}

export function promptText(prompt: acp.ContentBlock[]): string {
  const unsupported = prompt.find((block) => block.type !== "text");
  if (unsupported) {
    throw new Error(`Sigma ACP currently accepts text prompts; received '${unsupported.type}'.`);
  }
  const text = prompt.map((block) => block.type === "text" ? block.text : "").join("");
  if (!text) throw new Error("Sigma ACP prompt text must not be empty.");
  return text;
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

export function stopReason(outcome: RunOutcome): acp.StopReason {
  if (outcome.kind === "cancelled") return "cancelled";
  if (outcome.kind === "fatal" || outcome.kind === "recoverable_failure") return "refusal";
  return "end_turn";
}

export function expectedAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  return error === signal.reason
    || (error instanceof Error && (error.name === "AbortError" || /cancel|abort/iu.test(error.message)));
}
