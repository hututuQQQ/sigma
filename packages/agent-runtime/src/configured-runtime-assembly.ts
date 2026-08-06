import type { McpServerConfigValue } from "agent-config";
import { planContext } from "agent-context";
import type { ExecutionBroker } from "agent-execution";
import type { HookRunnerPort } from "agent-extensions";
import type { JsonValue, ModelGateway, RunMode, RunStore } from "agent-protocol";
import type { SegmentedJsonlStore } from "agent-store";
import type { AgentSupervisor } from "agent-supervisor";
import { connectMcpServers } from "./composition-mcp.js";
import type { RuntimeMcpHttpServerConfig } from "./composition-mcp.js";
import { createRuntime, type CreateRuntimeOptions } from "./create-runtime.js";
import { auditDurableChildren } from "./durable-children.js";
import { brokerRuntimeEnvironment } from "./execution-capabilities.js";
import type { RuntimeCustomization } from "./customization.js";
import type { createRoleGateways } from "./model-composition.js";
import type { SubjectAttestationContext } from "./subject-attestation.js";
import type { ChildJoinSummary } from "./types.js";
import type { createConfiguredTools } from "./configured-runtime-tools.js";
import type { FrozenHarnessBuild, HarnessReasoningEffort } from "./harness-compiler.js";
import { compileRuntimeHarness } from "./runtime-harness.js";
import { baseContext } from "./runtime-context.js";
import { modelTools } from "./effect-helpers.js";
import { projectModelToolDescriptors } from "./model-tool-projection.js";
import { withReadBatchDescriptor } from "./read-batch-tool.js";
import { projectInitialHarnessToolDescriptors } from "./harness-tool-projection.js";

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
  reasoningEffort?: HarnessReasoningEffort;
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
    parentRunId,
    new Set(jobs.map((job) => job.id))
  );
  return {
    evidence: [...evidence, ...durable.evidence],
    failures: [...failures, ...durable.failures]
  };
}

async function measureInitialHarnessTokens(input: {
  build: FrozenHarnessBuild;
  mode: RunMode;
  runtimeOptions: CreateRuntimeOptions;
  gateway: ModelGateway;
  tools: ReturnType<typeof createConfiguredTools>;
  skillsAvailable: boolean;
}) {
  const { build, mode, runtimeOptions, gateway, tools, skillsAvailable } = input;
  const descriptors = projectInitialHarnessToolDescriptors(
    build,
    withReadBatchDescriptor(projectModelToolDescriptors(
      tools.modelDescriptors?.() ?? tools.descriptors(),
      {
        skillsAvailable,
        environmentMutationAvailable: mode === "change",
        processControlsAvailable: false,
        childControlsAvailable: false,
        planReadRequired: false
      }
    ))
  );
  const definitions = modelTools(descriptors);
  const prompt = planContext({
    system: baseContext(runtimeOptions.runtimeEnvironment, build),
    history: [],
    dynamic: [],
    tools: definitions,
    contextWindowTokens: gateway.capabilities.contextWindowTokens,
    outputReserveTokens: 0,
    promptCache: false
  }).messages;
  const [mandatoryPromptTokens, initialToolSchemaTokens, combinedTokens] =
    await Promise.all([
      gateway.countTokens(prompt, []),
      gateway.countTokens([], definitions),
      gateway.countTokens(prompt, definitions)
    ]);
  return {
    tokenizer: gateway.capabilities.tokenizer,
    countMethod: "gateway.countTokens" as const,
    mandatoryPromptTokens,
    initialToolSchemaTokens,
    combinedTokens,
    mandatoryPromptBytes: Buffer.byteLength(JSON.stringify(prompt), "utf8"),
    initialToolSchemaBytes: Buffer.byteLength(JSON.stringify(definitions), "utf8")
  };
}

function createHarnessInspectors(input: {
  runtimeOptions: CreateRuntimeOptions;
  gateway: ModelGateway;
  tools: ReturnType<typeof createConfiguredTools>;
  customization: RuntimeCustomization;
}) {
  const { runtimeOptions, gateway, tools, customization } = input;
  const inspectHarness = (mode: RunMode) => compileRuntimeHarness(
    runtimeOptions, gateway, "orchestrator", mode, customization.profile
  );
  return {
    inspectHarness,
    inspectHarnessTokens: async (mode: RunMode) => await measureInitialHarnessTokens({
      build: inspectHarness(mode), mode, runtimeOptions, gateway, tools,
      skillsAvailable: customization.skills.descriptors.length > 0
    })
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
  builtinToolNames: readonly string[];
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
    builtinToolNames,
    subjectAttestation,
    agentProfileHookRunner
  } = input;
  const { storeRootDir, customization, execution, executionReport, hookRunner } = prepared;
  const runtimeOptions: CreateRuntimeOptions = {
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
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    builtinToolNames,
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
  };
  const inspectors = createHarnessInspectors({
    runtimeOptions, gateway: gateways.orchestrator, tools, customization
  });
  return {
    runtime: createRuntime(runtimeOptions),
    ...inspectors
  };
}
