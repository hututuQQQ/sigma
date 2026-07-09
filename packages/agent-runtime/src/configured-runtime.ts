import path from "node:path";
import type { McpServerConfigValue } from "agent-config";
import { createModelGateway, defaultModel } from "agent-model";
import type { JsonValue, ModelGateway, RunStore } from "agent-protocol";
import { SegmentedJsonlStore } from "agent-store";
import { AgentSupervisor, WorkspaceIsolationManager } from "agent-supervisor";
import { EffectToolRegistry, registerBuiltinTools, registerSupervisorTools } from "agent-tools";
import { closeMcpClients, connectMcpServers } from "./composition-mcp.js";
import { createChildAgentFactory } from "./composition-supervision.js";
import { createRuntime } from "./create-runtime.js";
import type { InProcessRuntimeClient } from "./runtime-client.js";
import type { ChildJoinSummary } from "./types.js";
import { auditDurableChildren } from "./durable-children.js";

export interface RuntimeCompositionConfig {
  workspace: string;
  provider: "deepseek" | "glm";
  model: string;
  permissionMode: "ask" | "auto" | "deny";
  runDeadlineSec: number;
  modelDeadlineSec: number;
  streamIdleSec: number;
  maxParallelTools: number;
  maxParallelAgents: number;
  mcpServers: McpServerConfigValue[];
}

export interface RuntimeFactoryDeps {
  gatewayFactory?: (options: { provider: "deepseek" | "glm"; model: string }) => ModelGateway;
}

export interface ConfiguredRuntime {
  runtime: InProcessRuntimeClient;
  workspace: string;
  close(): Promise<void>;
}

export interface RuntimeFactoryOptions { connectMcp?: boolean; }

async function joinChildren(supervisor: AgentSupervisor, store: RunStore, parentId: string, signal: AbortSignal): Promise<ChildJoinSummary> {
  const jobs = await supervisor.joinParent(parentId, signal);
  const evidence: JsonValue[] = jobs.map((job) => JSON.parse(JSON.stringify({
    childId: job.id,
    status: job.status,
    outcome: job.result?.outcome.kind ?? null,
    report: job.result?.report ?? null,
    isolation: job.isolation ?? null,
    error: job.error ?? null
  })) as JsonValue);
  const failures = jobs.flatMap((job) => {
    if (job.status !== "completed" || job.result?.outcome.kind !== "completed") {
      return [`Child ${job.id} ended as ${job.result?.outcome.kind ?? job.status}: ${job.error ?? "no report"}`];
    }
    return job.isolation?.kind === "git_worktree" && job.isolation.cleanup === "retained"
      ? [`Child ${job.id} has an unintegrated worktree at ${job.isolation.worktreePath}`] : [];
  });
  const durable = await auditDurableChildren(store, parentId, new Set(jobs.map((job) => job.id)));
  return { evidence: [...evidence, ...durable.evidence], failures: [...failures, ...durable.failures] };
}

export async function createConfiguredRuntime(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps = {},
  options: RuntimeFactoryOptions = {}
): Promise<ConfiguredRuntime> {
  const workspace = path.resolve(config.workspace);
  const model = config.model === "auto" ? defaultModel(config.provider) : config.model;
  const gateway = deps.gatewayFactory?.({ provider: config.provider, model }) ?? createModelGateway({
    provider: config.provider,
    model: config.model === "auto" ? undefined : model,
    requestTimeoutMs: config.modelDeadlineSec * 1_000,
    idleTimeoutMs: config.streamIdleSec * 1_000
  });
  const storeRootDir = path.join(workspace, ".agent");
  const runtimeReference: { current?: InProcessRuntimeClient } = {};
  const supervisor = new AgentSupervisor(
    createChildAgentFactory(() => runtimeReference.current as InProcessRuntimeClient),
    config.maxParallelAgents,
    new WorkspaceIsolationManager(),
    async (event) => {
      const runtime = runtimeReference.current;
      if (!runtime) throw new Error("Runtime is not ready to record child events.");
      await runtime.recordChildEvent(event.parentId, event.type, { childId: event.childId, payload: event.payload });
    }
  );
  const tools = registerSupervisorTools(registerBuiltinTools(new EffectToolRegistry()), supervisor);
  const mcpClients = options.connectMcp === false ? [] : await connectMcpServers(config.mcpServers, workspace, tools);
  const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
  const runtime = createRuntime({
    gateway,
    store,
    storeRootDir,
    tools,
    permissionMode: config.permissionMode,
    runDeadlineMs: config.runDeadlineSec * 1_000,
    maxParallelTools: config.maxParallelTools,
    joinChildren: async (parentId, signal) => await joinChildren(supervisor, store, parentId, signal),
    cancelChildren: (parentId, reason) => { supervisor.cancelParent(parentId, reason); }
  });
  runtimeReference.current = runtime;
  return { workspace, runtime, close: async () => await closeMcpClients(mcpClients) };
}
