import path from "node:path";
import { realpath } from "node:fs/promises";
import type {
  McpConfigSource, McpServerConfigValue, ModelRouteConfigValue, ModelSpecConfigValue,
  WorkspaceCustomizationTrustAttestation,
  WorkspaceMcpTrustAttestation
} from "agent-config";
import type { ModelGateway, RuntimeClient } from "agent-protocol";
import type {
  BrokerDoctorReport,
  ContainerEngine,
  ContainerTarget,
  ExecutionBroker,
  TrustedContainerLauncher
} from "agent-execution";
import type { HookDefinition, HookRunnerPort } from "agent-extensions";
import { SegmentedJsonlStore } from "agent-store";
import { AgentSupervisor, WorkspaceIsolationManager } from "agent-supervisor";
import { ensurePrivateStateDirectory, isInside } from "agent-platform";
import { closeMcpClients, connectMcpServers } from "./composition-mcp.js";
import { createChildAgentFactory } from "./composition-supervision.js";
import type { InProcessRuntimeClient } from "./runtime-client.js";
import { verifyWorkspaceMcpTrust } from "./workspace-mcp-trust.js";
import { runtimeStateRoot } from "./runtime-state.js";
import { configuredExecutionBroker } from "./container-runtime-execution.js";
import { resolveRuntimeCustomization, type RuntimeCustomization } from "./customization.js";
import { BrokerCommandHookRunner } from "./hook-runner.js";
import { frozenHookExecutionRoot } from "./frozen-hook-assets.js";
import { verifyWorkspaceCustomizationTrust } from "./workspace-customization-trust.js";
import { createRoleGateways } from "./model-composition.js";
import { createSubjectAttestationContext, type SubjectProductAttestation } from "./subject-attestation.js";
import { subjectConfiguration } from "./subject-configuration.js";
import { brokerRuntimeEnvironment } from "./execution-capabilities.js";
import { createConfiguredTools } from "./configured-runtime-tools.js";
import {
  configuredMcpClients,
  createComposedRuntime,
  type RuntimeAssemblyPrepared
} from "./configured-runtime-assembly.js";
export interface RuntimeCompositionConfig {
  workspace: string;
  provider: "deepseek" | "glm";
  model: string;
  permissionMode: "workspace-auto" | "ask" | "auto" | "deny";
  runDeadlineSec: number;
  modelDeadlineSec: number;
  streamIdleSec: number;
  streamActiveSec?: number;
  maxModelRetries?: number;
  maxParallelTools: number;
  commandTimeoutSec?: number;
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
  managedEnvironmentMode?: "disabled" | "required";
  readScope?: "workspace" | "host";
  writeScope?: "workspace" | "enclosing-container";
  networkMode?: "none" | "loopback" | "full";
  webMode?: "auto" | "disabled";
  webSearchProvider?: "exa";
  processHandoff?: "allow" | "deny";
  reviewerWaiver?: boolean;
  explicitSingleModelRoute?: boolean;
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
  /** Trusted product launcher input. Never derive this from workspace, model,
   * task metadata, CLI flags, or general environment variables. */
  containerLauncher?: TrustedContainerLauncher;
  hookDefinitions?: readonly HookDefinition[];
  hookRunner?: HookRunnerPort;
  agentProfileHookRunner?: HookRunnerPort;
  /** Trusted launcher input. CLI flags, environment variables, workspaces, and
   * evaluator inputs must never populate this contract. */
  subjectProductAttestation?: SubjectProductAttestation;
}
export interface ConfiguredRuntime {
  runtime: RuntimeClient;
  workspace: string;
  storeRootDir: string;
  execution: ExecutionBroker;
  close(): Promise<void>;
}
export interface RuntimeFactoryOptions { connectMcp?: boolean; surface?: "cli" | "tui"; interactiveApprovals?: boolean; }

interface PreparedComposition extends RuntimeAssemblyPrepared {
  workspace: string;
}

function configuredSubjectAttestation(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps,
  options: RuntimeFactoryOptions,
  executionReport: BrokerDoctorReport
) {
  if (deps.subjectProductAttestation && !options.surface) {
    throw new Error("A trusted subject product attestation requires an explicit runtime surface.");
  }
  if (!deps.subjectProductAttestation || !options.surface) return undefined;
  return createSubjectAttestationContext(
    deps.subjectProductAttestation,
    subjectConfiguration(config),
    options.surface,
    brokerRuntimeEnvironment(executionReport).platform
  );
}

export async function createConfiguredRuntime(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps = {},
  options: RuntimeFactoryOptions = {}
): Promise<ConfiguredRuntime> {
  const prepared = await prepareComposition(config, deps, options);
  const { workspace, storeRootDir, customization, execution, executionReport } = prepared;
  let mcpClients: Awaited<ReturnType<typeof connectMcpServers>> = [];
  try {
    const gateways = createRoleGateways(config, deps, customization);
    const subjectAttestation = configuredSubjectAttestation(
      config,
      deps,
      options,
      executionReport
    );
    const runtimeReference: { current?: InProcessRuntimeClient } = {};
    const supervisor = createSupervisor(config, execution, runtimeReference);
    const tools = createConfiguredTools(config, execution, supervisor, executionReport, storeRootDir);
    mcpClients = await configuredMcpClients(
      options.connectMcp !== false,
      config.mcpServers,
      workspace,
      tools,
      execution
    );
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createComposedRuntime({
      config,
      interactiveApprovals: options.interactiveApprovals ?? options.surface !== "cli",
      prepared,
      gateways,
      tools,
      store,
      supervisor,
      subjectAttestation,
      agentProfileHookRunner: deps.agentProfileHookRunner
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
  const storeRootDir = await prepareStoreRoot(
    deps.stateRootDir ?? runtimeStateRoot(workspace),
    workspace
  );
  const customization = await resolveRuntimeCustomization(config, workspace, undefined, deps.hookDefinitions);
  verifyCustomization(config, workspace, customization);
  const execution = await configuredExecutionBroker(config, deps, workspace);
  try {
    const hookRunner = createHookRunner(config, deps, workspace, storeRootDir, customization, execution);
    const executionReport = await execution.connect();
    assertManagedRuntimeAvailable(config, execution, executionReport);
    assertEnclosingContainerRuntimeAvailable(config, executionReport);
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

function assertEnclosingContainerRuntimeAvailable(
  config: RuntimeCompositionConfig,
  report: BrokerDoctorReport
): void {
  if ((config.writeScope ?? "workspace") !== "enclosing-container") return;
  if ((config.readScope ?? "workspace") !== "host") {
    throw Object.assign(new Error(
      "Enclosing-container write scope requires readScope=host so every declared mutation root can be inspected and reviewed."
    ), { code: "enclosing_container_read_scope_required" });
  }
  const capability = report.capabilities.enclosingContainerRoot;
  if (config.executionMode === "container"
    || capability?.available !== true
    || capability.rootKind !== "container_cow"
    || !capability.attestationDigest) {
    throw Object.assign(new Error(
      "Enclosing-container write scope was requested, but the native broker could not attest a disposable copy-on-write container boundary."
    ), {
      code: "enclosing_container_unavailable",
      reason: capability?.reason
    });
  }
}

function assertManagedRuntimeAvailable(
  config: RuntimeCompositionConfig,
  execution: ExecutionBroker,
  report: BrokerDoctorReport
): void {
  if ((config.managedEnvironmentMode ?? "disabled") !== "required") return;
  if (config.executionMode !== "container"
    || (config.containerTarget ?? "managed") !== "managed"
    || report.container?.available !== true
    || report.container.target !== "managed"
    || report.capabilities.runtimeClosure?.complete !== true
    || report.capabilities.managedEnvironment?.available !== true
    || report.capabilities.managedEnvironment.prepare !== true
    || typeof execution.bindManagedSession !== "function") {
    throw Object.assign(new Error(
      "Managed environment is required but its launcher proof, runtime closure, or session binding is unavailable."
    ), { code: "managed_environment_required_unavailable" });
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

async function canonicalPathAllowMissing(target: string): Promise<string> {
  let ancestor = path.resolve(target);
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      return path.resolve(canonical, path.relative(ancestor, target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function prepareStoreRoot(configuredRoot: string, workspace: string): Promise<string> {
  const storeRootDir = path.resolve(configuredRoot);
  if (isInside(workspace, await canonicalPathAllowMissing(storeRootDir))) {
    throw new Error("Runtime state root must be outside the workspace.");
  }
  await ensurePrivateStateDirectory(storeRootDir);
  const canonicalStoreRoot = await realpath(storeRootDir);
  if (isInside(workspace, canonicalStoreRoot)) {
    throw new Error("Runtime state root must remain outside the workspace after creation.");
  }
  return canonicalStoreRoot;
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
