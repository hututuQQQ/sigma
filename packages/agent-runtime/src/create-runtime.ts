import type { ModelGateway, RunStore, ToolExecutor } from "agent-protocol";
import { InProcessRuntimeClient } from "./runtime-client.js";
import type { ChildJoinSummary } from "./types.js";

export interface CreateRuntimeOptions {
  gateway: ModelGateway;
  store: RunStore;
  storeRootDir: string;
  tools: ToolExecutor;
  permissionMode?: "ask" | "auto" | "deny";
  runDeadlineMs?: number;
  maxParallelTools?: number;
  joinChildren?(parentSessionId: string, signal: AbortSignal): Promise<ChildJoinSummary>;
  cancelChildren?(parentSessionId: string, reason: string): Promise<void> | void;
}

export function createRuntime(options: CreateRuntimeOptions): InProcessRuntimeClient {
  return new InProcessRuntimeClient(options);
}
