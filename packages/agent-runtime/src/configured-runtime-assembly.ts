import type { McpServerConfigValue } from "agent-config";
import type { ExecutionBroker } from "agent-execution";
import type { HookRunnerPort } from "agent-extensions";
import type { JsonValue, RunStore } from "agent-protocol";
import type { SegmentedJsonlStore } from "agent-store";
import type { AgentSupervisor } from "agent-supervisor";
import { connectMcpServers } from "./composition-mcp.js";
import type { RuntimeMcpHttpServerConfig } from "./composition-mcp.js";
import { createRuntime } from "./create-runtime.js";
import {
  auditDurableChildRecords,
  durableChildCompletionFailure,
  readDurableChildren
} from "./durable-children.js";
import { brokerRuntimeEnvironment } from "./execution-capabilities.js";
import type { RuntimeCustomization } from "./customization.js";
import type { createRoleGateways } from "./model-composition.js";
import type { SubjectAttestationContext } from "./subject-attestation.js";
import type { ChildJoinSummary } from "./types.js";
import type { createConfiguredTools } from "./configured-runtime-tools.js";

export interface RuntimeAssemblyConfig {
  runDeadlineSec: number;
  maxParallelTools: number;
  managedEnvironmentMode?: "disabled" | "required";
  networkMode?: "none" | "loopback" | "full";
  webMode?: "auto" | "disabled";
  webSearchProvider?: "exa";
  executionMode?: "sandboxed" | "container";
  writeScope?: "workspace" | "enclosing-container";
  checkpoint?: { maxFiles: number; maxBytes: number };
}

export interface RuntimeAssemblyPrepared {
  storeRootDir: string;
  customization: RuntimeCustomization;
  execution: ExecutionBroker;
  executionReport: import("agent-execution").BrokerDoctorReport;
  hookRunner: HookRunnerPort;
}

export async function configuredMcpClients(
  connect: boolean,
  servers: McpServerConfigValue[],
  workspace: string,
  tools: ReturnType<typeof createConfiguredTools>,
  execution: ExecutionBroker,
  httpServers: readonly RuntimeMcpHttpServerConfig[] = []
) {
  if (!connect) return [];
  return await connectMcpServers(servers, workspace, tools, execution, httpServers);
}

async function joinChildren(
  supervisor: AgentSupervisor,
  store: RunStore,
  parentId: string,
  parentRunId: string,
  signal: AbortSignal
): Promise<ChildJoinSummary> {
  const jobs = await supervisor.joinParent(parentId, parentRunId, signal);
  const durableChildren = await readDurableChildren(store, parentId);
  const evidence: JsonValue[] = jobs.map((job) => JSON.parse(JSON.stringify({
    childId: job.id,
    status: job.status,
    outcome: job.result?.outcome.kind ?? null,
    report: job.result?.report ?? null,
    metadata: durableChildren.get(job.id)?.metadata ?? null,
    isolation: job.isolation ?? null,
    error: job.error ?? null
  })) as JsonValue);
  const failures = jobs.flatMap((job) => {
    const durable = durableChildren.get(job.id);
    if (durable?.runId === parentRunId) {
      const failure = durableChildCompletionFailure(durable);
      return failure ? [failure] : [];
    }
    // A missing durable spawn/completion cannot be treated as reconciled even
    // if the in-memory child happens to have a terminal result.
    if (job.status !== "completed" || job.result?.outcome.kind !== "completed") {
      return [`Child ${job.id} ended as ${job.result?.outcome.kind ?? job.status}: ${job.error ?? "no report"}`];
    }
    return job.isolation?.kind === "git_worktree" && job.isolation.cleanup === "retained"
      ? [`Child ${job.id} has an unintegrated worktree at ${job.isolation.worktreePath}`] : [];
  });
  const durable = auditDurableChildRecords(
    durableChildren,
    parentRunId,
    new Set(jobs.map((job) => job.id))
  );
  return {
    evidence: [...evidence, ...durable.evidence],
    failures: [...failures, ...durable.failures]
  };
}

export function createComposedRuntime(input: {
  config: RuntimeAssemblyConfig;
  interactiveApprovals: boolean;
  prepared: RuntimeAssemblyPrepared;
  gateways: ReturnType<typeof createRoleGateways>;
  tools: ReturnType<typeof createConfiguredTools>;
  store: SegmentedJsonlStore;
  supervisor: AgentSupervisor;
  subjectAttestation: SubjectAttestationContext | undefined;
  agentProfileHookRunner?: HookRunnerPort;
}) {
  const {
    config,
    interactiveApprovals,
    prepared,
    gateways,
    tools,
    store,
    supervisor,
    subjectAttestation,
    agentProfileHookRunner
  } = input;
  const { storeRootDir, customization, execution, executionReport, hookRunner } = prepared;
  return createRuntime({
    gateway: gateways.orchestrator,
    store,
    storeRootDir,
    tools,
    permissionMode: customization.permissionMode,
    interactiveApprovals,
    ...(config.runDeadlineSec > 0
      ? { runDeadlineMs: config.runDeadlineSec * 1_000 }
      : {}),
    maxParallelTools: config.maxParallelTools,
    budgetLimits: customization.budgetLimits,
    checkpointMaxFiles: config.checkpoint?.maxFiles,
    checkpointMaxBytes: config.checkpoint?.maxBytes,
    profile: customization.profile,
    profileSource: customization.profileSource,
    availableProfiles: customization.availableProfiles,
    gatewayForRole: gateways.forRole,
    execution,
    managedEnvironmentMode: config.managedEnvironmentMode ?? "disabled",
    managedNetworkMode: config.networkMode ?? "full",
    runtimeEnvironment: {
      ...brokerRuntimeEnvironment(executionReport),
      executionMode: config.executionMode ?? "sandboxed",
      writeScope: config.writeScope ?? "workspace",
      enclosingContainerAttestationDigest:
        executionReport.capabilities.enclosingContainerRoot?.attestationDigest
    },
    subjectAttestation,
    skills: customization.skills,
    hooks: customization.hookDefinitions,
    hookArtifacts: customization.hookArtifacts,
    hookRunner,
    agentProfileHookRunner,
    joinChildren: async (parentId, parentRunId, signal) =>
      await joinChildren(supervisor, store, parentId, parentRunId, signal),
    cancelChildren: async (parentId, parentRunId, reason) =>
      await supervisor.cancelParent(parentId, parentRunId, reason),
    hasActiveChildren: (parentId) => supervisor.list(parentId)
      .some((child) => child.status === "queued" || child.status === "running")
  });
}
