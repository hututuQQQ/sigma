import type { McpServerConfigValue } from "agent-config";
import type { ExecutionBroker } from "agent-execution";
import type { HookRunnerPort } from "agent-extensions";
import type { JsonValue, RunStore } from "agent-protocol";
import type { SegmentedJsonlStore } from "agent-store";
import type { AgentSupervisor } from "agent-supervisor";
import { connectMcpServers } from "./composition-mcp.js";
import { createRuntime } from "./create-runtime.js";
import { auditDurableChildren } from "./durable-children.js";
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
  execution: ExecutionBroker
) {
  if (!connect) return [];
  return await connectMcpServers(servers, workspace, tools, execution);
}

async function joinChildren(
  supervisor: AgentSupervisor,
  store: RunStore,
  parentId: string,
  signal: AbortSignal
): Promise<ChildJoinSummary> {
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
  const durable = await auditDurableChildren(
    store,
    parentId,
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
    runDeadlineMs: config.runDeadlineSec * 1_000,
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
    joinChildren: async (parentId, signal) =>
      await joinChildren(supervisor, store, parentId, signal),
    cancelChildren: async (parentId, reason) =>
      await supervisor.cancelParent(parentId, reason),
    hasActiveChildren: (parentId) => supervisor.list(parentId)
      .some((child) => child.status === "queued" || child.status === "running")
  });
}
