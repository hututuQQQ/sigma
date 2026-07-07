import { createModelClient, type ProviderName } from "agent-ai";
import {
  AgentEventBus,
  runAgent,
  type AgentEvent,
  type AgentRunResult,
  type PermissionMode
} from "agent-core";
import type { TuiPermissionController } from "./permission.js";

export interface RunSessionOptions {
  instruction: string;
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  permissionController: TuiPermissionController;
  onEvent(event: AgentEvent): void;
}

export async function runSession(options: RunSessionOptions): Promise<AgentRunResult> {
  const eventBus = new AgentEventBus();
  const unsubscribe = eventBus.on(options.onEvent);
  const modelClient = createModelClient(options.provider, { model: options.model });

  try {
    return await runAgent({
      instruction: options.instruction,
      workspacePath: options.workspacePath,
      modelClient,
      permissionMode: options.permissionMode,
      permissionDecider: options.permissionMode === "ask" ? options.permissionController : undefined,
      contextMode: "repo-map",
      eventBus
      // TODO: when agent-core emits assistant delta events from modelClient.stream, render token-level updates here.
    });
  } finally {
    unsubscribe();
  }
}
