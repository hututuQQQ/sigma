import path from "node:path";
import { realpath } from "node:fs/promises";
import type {
  McpConfigSource, McpServerConfigValue, ModelRouteConfigValue, ModelSpecConfigValue,
  WorkspaceCustomizationTrustAttestation,
  WorkspaceMcpTrustAttestation
} from "agent-config";
import type { JsonValue, ModelGateway, RunStore, RuntimeClient } from "agent-protocol";
import type {
  BrokerDoctorReport,
  ContainerEngine,
  ContainerTarget,
  ExecutionBroker,
  TrustedContainerLauncherV1
} from "agent-execution";
import type { HookDefinition, HookRunnerPort } from "agent-extensions";
import { defaultBundledLanguageServerRoot, discoverLanguageServers, type LanguageServerPreset } from "agent-code-intel";
import { SegmentedJsonlStore } from "agent-store";
import { AgentSupervisor, WorkspaceIsolationManager } from "agent-supervisor";
import { EffectToolRegistry, registerBuiltinTools, registerSupervisorTools } from "agent-tools";
import { closeMcpClients, connectMcpServers } from "./composition-mcp.js";
import { createChildAgentFactory } from "./composition-supervision.js";
import { createRuntime } from "./create-runtime.js";
import type { InProcessRuntimeClient } from "./runtime-client.js";
import type { ChildJoinSummary } from "./types.js";
import { auditDurableChildren, childLimitationEvidenceSources } from "./durable-children.js";
import { verifyWorkspaceMcpTrust } from "./workspace-mcp-trust.js";
import { configuredExecutionBroker } from "./container-runtime-execution.js";
import { prepareRuntimeStoreRoot } from "./runtime-store-root.js";
import { runtimeStateRoot } from "./runtime-state.js";
import { resolveRuntimeCustomization, type RuntimeCustomization } from "./customization.js";
import { BrokerCommandHookRunner } from "./hook-runner.js";
import { frozenHookExecutionRoot } from "./frozen-hook-assets.js";
import { ModelReviewer } from "./reviewer.js";
import { verifyWorkspaceCustomizationTrust } from "./workspace-customization-trust.js";
import { createRoleGateways, reviewerRouteId } from "./model-composition.js";
import { createSubjectAttestationContextV1, type SubjectProductAttestationV1 } from "./subject-attestation.js";
import { subjectConfigurationV1 } from "./subject-configuration.js";
import { repositoryRuntimeProviders } from "./repository-statistics-provider.js";
import { repositoryTransactionTool } from "./repository-transaction-tool.js";
import {
  brokerRuntimeEnvironment, configuredRuntimeEnvironment, verifiedExecutionBackend,
  verifiedNetworkPolicy, verifiedRuntimeCommands, verifiedShellKinds
} from "./execution-capabilities.js";
export interface RuntimeCompositionConfig {
  workspace: string;
  provider: "deepseek" | "glm";
  model: string;
  permissionMode: "workspace-auto" | "ask" | "auto" | "deny";
  runDeadlineSec: number; commandTimeoutSec?: number;
  modelDeadlineSec: number;
  streamIdleSec: number;
  streamActiveSec?: number;
  maxModelRetries?: number;
  maxParallelTools: number;
  maxParallelAgents: number;
  mcpServers: McpServerConfigValue[];
  mcpSource: McpConfigSource;
  workspaceMcpTrust?: WorkspaceMcpTrustAttestation;
  workspaceCustomizationTrust?: WorkspaceCustomizationTrustAttestation;
  agentProfile?: string;
  sandboxMode?: "required";
  executionMode?: "sandboxed" | "container";
  containerEngine?: ContainerEngine;
  containerTarget?: ContainerTarget;
  containerImage?: string;
  readScope?: "workspace" | "host";
  networkMode?: "none" | "loopback" | "full";
  processHandoff?: "allow" | "deny";
  reviewerWaiver?: boolean;
  legacySingleModelRoute?: boolean;
  modelSpecs?: readonly ModelSpecConfigValue[];
  modelRoutes?: readonly ModelRouteConfigValue[];
  budget?: {
    maxInputTokens: number; maxOutputTokens: number; maxCostMicroUsd: number;
    maxModelTurns: number; maxToolCalls: number; maxChildren: number; maxDepth: number;
  };
  checkpoint?: { maxFiles: number; maxBytes: number };
}
export interface RuntimeFactoryDeps {
  gatewayFactory?: (options: { provider: "deepseek" | "glm"; model: string; maxRetries: number;
    requestTimeoutMs: number; idleTimeoutMs: number; activeStreamTimeoutMs?: number }) => ModelGateway;
  stateRootDir?: string;
  executionBroker?: ExecutionBroker;
  /** Trusted product launcher input. This must never be populated from CLI,
   * environment, workspace configuration, task metadata, or model output. */
  containerLauncher?: TrustedContainerLauncherV1;
  hookDefinitions?: readonly HookDefinition[];
  hookRunner?: HookRunnerPort;
  agentProfileHookRunner?: HookRunnerPort;
  /** Trusted launcher input. CLI flags, environment variables, workspaces, and
   * evaluator inputs must never populate this contract. */
  subjectProductAttestation?: SubjectProductAttestationV1;
}
export interface ConfiguredRuntime {
  runtime: RuntimeClient;
  workspace: string;
  storeRootDir: string;
  execution: ExecutionBroker;
  close(): Promise<void>;
}
export interface RuntimeFactoryOptions { connectMcp?: boolean; surface?: "cli" | "tui"; interactiveApprovals?: boolean; }
interface PreparedComposition {
  workspace: string;
  storeRootDir: string;
  customization: RuntimeCustomization;
  execution: ExecutionBroker;
  executionReport: BrokerDoctorReport;
  hookRunner: HookRunnerPort;
}
async function joinChildren(supervisor: AgentSupervisor, store: RunStore, parentId: string, signal: AbortSignal): Promise<ChildJoinSummary> {
  const jobs = await supervisor.joinParent(parentId, signal);
  const evidence: JsonValue[] = jobs.map((job) => JSON.parse(JSON.stringify({
    childId: job.id,
    status: job.status,
    outcome: job.result?.outcome ?? null,
    report: job.result?.report ?? null,
    isolation: job.isolation ?? null,
    error: job.error ?? null
  })) as JsonValue);
  const limitations = jobs.flatMap((job) => job.result?.outcome.kind === "completed_with_limitations"
    ? job.result.outcome.limitations : []);
  const limitationEvidence = jobs.flatMap((job) => job.result
    ? childLimitationEvidenceSources(
      job.id,
      JSON.parse(JSON.stringify(job.result.outcome)) as JsonValue
    ) : []);
  const failures = jobs.flatMap((job) => {
    if (job.status !== "completed" || (job.result?.outcome.kind !== "completed"
      && job.result?.outcome.kind !== "completed_with_limitations")) {
      return [`Child ${job.id} ended as ${job.result?.outcome.kind ?? job.status}: ${job.error ?? "no report"}`];
    }
    if (job.result?.outcome.kind === "completed_with_limitations"
      && childLimitationEvidenceSources(
        job.id,
        JSON.parse(JSON.stringify(job.result.outcome)) as JsonValue
      ).length !== job.result.outcome.limitations.length) {
      return [`Child ${job.id} reported a limitation without resolvable validation evidence.`];
    }
    return job.isolation?.kind === "git_worktree" && job.isolation.cleanup === "retained"
      ? [`Child ${job.id} has an unintegrated worktree at ${job.isolation.worktreePath}`] : [];
  });
  const durable = await auditDurableChildren(store, parentId, new Set(jobs.map((job) => job.id)));
  return {
    evidence: [...evidence, ...durable.evidence],
    failures: [...failures, ...durable.failures],
    limitations: [...limitations, ...(durable.limitations ?? [])],
    limitationEvidence: [...limitationEvidence, ...(durable.limitationEvidence ?? [])]
  };
}

export async function createConfiguredRuntime(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps = {},
  options: RuntimeFactoryOptions = {}
): Promise<ConfiguredRuntime> {
  const prepared = await prepareComposition(config, deps, options);
  const { workspace, storeRootDir, customization, execution, executionReport, hookRunner } = prepared;
  let mcpClients: Awaited<ReturnType<typeof connectMcpServers>> = [];
  try {
    const gateways = createRoleGateways(config, deps, customization);
    if (deps.subjectProductAttestation && !options.surface) {
      throw new Error("A trusted subject product attestation requires an explicit runtime surface.");
    }
    const subjectAttestation = deps.subjectProductAttestation && options.surface
      ? createSubjectAttestationContextV1(
        deps.subjectProductAttestation,
        subjectConfigurationV1(config),
        options.surface,
        brokerRuntimeEnvironment(executionReport).platform
      )
      : undefined;
    const runtimeReference: { current?: InProcessRuntimeClient } = {};
    const supervisor = createSupervisor(config, execution, runtimeReference);
    const languageServers = discoverLanguageServers();
    const tools = createTools(config, execution, supervisor, executionReport, storeRootDir, languageServers);
    mcpClients = options.connectMcp === false
      ? [] : await connectMcpServers(config.mcpServers, workspace, tools, execution);
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: gateways.orchestrator,
      store,
      storeRootDir,
      tools,
      permissionMode: customization.permissionMode,
      interactiveApprovals: options.interactiveApprovals ?? options.surface !== "cli",
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
      runtimeEnvironment: configuredRuntimeEnvironment(
        executionReport, config.executionMode ?? "sandboxed", languageServers
      ),
      subjectAttestation,
      skills: customization.skills,
      hooks: customization.hookDefinitions,
      hookArtifacts: customization.hookArtifacts,
      hookRunner,
      agentProfileHookRunner: deps.agentProfileHookRunner,
      reviewer: new ModelReviewer(gateways.reviewer, reviewerRouteId(customization.profile)),
      reviewerForSession: (session) => new ModelReviewer(
        gateways.forRole("reviewer", session.services.profile),
        reviewerRouteId(session.services.profile)
      ),
      joinChildren: async (parentId, signal) => await joinChildren(supervisor, store, parentId, signal),
      cancelChildren: async (parentId, reason) => await supervisor.cancelParent(parentId, reason),
      hasActiveChildren: (parentId) => supervisor.list(parentId)
        .some((child) => child.status === "queued" || child.status === "running")
    });
    runtimeReference.current = runtime;
    return {
      workspace,
      storeRootDir,
      runtime,
      execution,
      close: async () => await closeComposition(mcpClients, execution)
    };
  } catch (error) {
    return await rethrowAfterCompositionClose(mcpClients, execution, error);
  }
}

async function closeComposition(
  mcpClients: Parameters<typeof closeMcpClients>[0],
  execution: ExecutionBroker
): Promise<void> {
  let mcpFailure: unknown;
  try {
    await closeMcpClients(mcpClients);
  } catch (error) {
    mcpFailure = error;
  }
  try {
    await execution.close();
  } catch (error) {
    if (mcpFailure) {
      throw new AggregateError(
        [mcpFailure, error],
        "Runtime resources could not be closed cleanly.",
        { cause: error }
      );
    }
    throw error;
  }
  if (mcpFailure) throw mcpFailure;
}

async function rethrowAfterCompositionClose(
  mcpClients: Parameters<typeof closeMcpClients>[0],
  execution: ExecutionBroker,
  failure: unknown
): Promise<never> {
  try {
    await closeComposition(mcpClients, execution);
  } catch (cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      "Runtime composition failed and its resources could not be closed.",
      { cause: cleanupFailure }
    );
  }
  throw failure;
}

async function prepareComposition(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps,
  options: RuntimeFactoryOptions
): Promise<PreparedComposition> {
  const workspace = await realpath(path.resolve(config.workspace));
  await verifyMcpTrust(config, options, workspace);
  const storeRootDir = await prepareRuntimeStoreRoot(
    deps.stateRootDir ?? runtimeStateRoot(workspace),
    workspace
  );
  const customization = await resolveRuntimeCustomization(config, workspace, undefined, deps.hookDefinitions);
  verifyCustomization(config, workspace, customization);
  const execution = await configuredExecutionBroker(config, deps, workspace);
  try {
    const hookRunner = createHookRunner(config, deps, workspace, storeRootDir, customization, execution);
    const executionReport = await execution.connect();
    return {
      workspace,
      storeRootDir,
      customization,
      execution,
      executionReport,
      hookRunner
    };
  } catch (error) {
    return await rethrowAfterCompositionClose([], execution, error);
  }
}

async function verifyMcpTrust(
  config: RuntimeCompositionConfig,
  options: RuntimeFactoryOptions,
  workspace: string
): Promise<void> {
  if (options.connectMcp === false || config.mcpServers.length === 0) return;
  await verifyWorkspaceMcpTrust(workspace, config.mcpSource, config.workspaceMcpTrust);
}

function verifyCustomization(
  config: RuntimeCompositionConfig,
  workspace: string,
  customization: RuntimeCustomization
): void {
  verifyWorkspaceCustomizationTrust(
    workspace,
    customization.workspaceExecutableHookIds,
    config.workspaceCustomizationTrust,
    customization.workspaceExecutableHookArtifacts
  );
}

function createHookRunner(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps,
  workspace: string,
  storeRootDir: string,
  customization: RuntimeCustomization,
  execution: ExecutionBroker
): HookRunnerPort {
  return deps.hookRunner ?? new BrokerCommandHookRunner(
    execution,
    workspace,
    undefined,
    process.env,
    (hookId) => {
      if (!customization.workspaceExecutableHookIds.includes(hookId)) return;
      verifyCustomization(config, workspace, customization);
    },
    frozenHookExecutionRoot(storeRootDir)
  );
}

function createSupervisor(
  config: RuntimeCompositionConfig,
  execution: ExecutionBroker,
  runtimeReference: { current?: InProcessRuntimeClient }
): AgentSupervisor {
  return new AgentSupervisor(
    createChildAgentFactory(() => runtimeReference.current as InProcessRuntimeClient),
    config.maxParallelAgents,
    new WorkspaceIsolationManager(undefined, { execution }),
    async (event) => {
      const runtime = runtimeReference.current;
      if (!runtime) throw new Error("Runtime is not ready to record child events.");
      await runtime.recordChildEvent(event.parentId, event.type, { childId: event.childId, payload: event.payload });
    }
  );
}

function createTools(config: RuntimeCompositionConfig, execution: ExecutionBroker,
  supervisor: AgentSupervisor, executionReport: BrokerDoctorReport,
  storeRootDir: string, languageServers: LanguageServerPreset[]): EffectToolRegistry {
  const network = verifiedNetworkPolicy(executionReport, config.networkMode ?? "none");
  const executionBackend = verifiedExecutionBackend(executionReport);
  const builtins = registerBuiltinTools(new EffectToolRegistry(), {
    broker: execution,
    executionBackend,
    executionPlatform: brokerRuntimeEnvironment(executionReport).platform,
    atomicPatchStateRootDir: storeRootDir,
    sandboxMode: "required", commandTimeoutSec: config.commandTimeoutSec ?? 600,
    readScope: config.readScope ?? "workspace",
    processHandoff: config.processHandoff ?? "allow",
    networkMode: network.defaultMode,
    networkModes: network.modes,
    shells: verifiedShellKinds(executionReport),
    runtimeCommands: verifiedRuntimeCommands(executionReport),
    foreground: executionReport.capabilities.foreground,
    background: executionReport.capabilities.background,
    stdin: executionReport.capabilities.stdin,
    pty: executionReport.capabilities.pty,
    handoff: config.processHandoff !== "deny"
      && executionReport.capabilities.processHandoff === true
      && typeof execution.handoff === "function",
    ...repositoryRuntimeProviders,
    ...(executionReport.capabilities.background
      && executionReport.capabilities.stdin
      && network.modes.includes("none") ? {
      codeIntel: {
        presets: languageServers,
        additionalReadRoots: [defaultBundledLanguageServerRoot()]
          .filter((value): value is string => Boolean(value))
      }
    } : {})
  });
  builtins.register(repositoryTransactionTool(execution, {
    maxFiles: config.checkpoint?.maxFiles, maxBytes: config.checkpoint?.maxBytes
  }));
  return registerSupervisorTools(builtins, supervisor);
}
