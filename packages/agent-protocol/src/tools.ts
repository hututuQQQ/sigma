import type { JsonValue } from "./json.js";

export type ToolEffect =
  | "filesystem.read"
  | "filesystem.write"
  | "process.spawn"
  | "process.spawn.readonly"
  | "agent.spawn"
  | "network"
  | "validation"
  | "outcome.propose"
  | "destructive"
  | "open_world";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
  possibleEffects: ToolEffect[];
  executionMode: "parallel" | "sequential" | "exclusive";
  resourceKeys: string[];
  contextPathArguments?: string[];
  writePathArguments?: string[];
  approval: "auto" | "prompt" | "deny";
  idempotent: boolean;
  timeoutMs: number;
  idleTimeoutMs?: number;
}

export interface ToolRequest {
  callId: string;
  name: string;
  arguments: JsonValue;
}

export interface WorkspaceDelta {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface ToolReceipt {
  callId: string;
  ok: boolean;
  output: string;
  observedEffects: ToolEffect[];
  workspaceDelta?: WorkspaceDelta;
  artifacts: string[];
  diagnostics: string[];
  startedAt: string;
  completedAt: string;
}

export interface ToolExecutionContext {
  sessionId: string;
  runId: string;
  workspacePath: string;
  runMode: import("./outcomes.js").RunMode;
  signal: AbortSignal;
  heartbeat(): void;
  progress(update: { message: string; percent?: number }): Promise<void>;
  createArtifact(input: { name: string; content: string }): Promise<string>;
}

export interface ToolExecutor {
  descriptors(): readonly ToolDescriptor[];
  execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt>;
}
