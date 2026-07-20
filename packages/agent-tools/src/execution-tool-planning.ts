import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPolicy, ScratchLeaseV1 } from "agent-execution";
import type {
  ExecutionIntentV1,
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan,
  ToolPreparationContext
} from "agent-protocol";
import { isInside, resolveWorkspacePath } from "agent-platform";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  assertAvailableExecutable,
  availableNetworkModes,
  executionArgs
} from "./execution-tool-values.js";
import { processMutationContract, writePlanError } from "./process-mutation-contract.js";
import type { PlannedToolExecutionContext } from "./registry.js";
import { executionCommandSemantics } from "./execution-command-semantics.js";
import { ociWorkspaceExecutableRoots } from "./execution-oci-paths.js";
import { validationWorkspacePolicy } from "./execution-validation-workspace.js";

function network(input: Record<string, JsonValue>, options: ExecutionToolOptions): "none" | "loopback" | "full" {
  const available = availableNetworkModes(options);
  const fallback = available.includes(options.networkMode) ? options.networkMode : available[0];
  const value = input.network ?? fallback;
  if (value !== "none" && value !== "loopback" && value !== "full") {
    throw new Error("network must be none, loopback, or full.");
  }
  if (!available.includes(value)) {
    throw Object.assign(new Error(`Network mode '${value}' is not available for this execution broker.`), {
      code: "network_unavailable"
    });
  }
  return value;
}

function plannedEffects(
  writes: boolean,
  validation: boolean,
  networkMode: "none" | "loopback" | "full",
  readsSkillResource: boolean,
  readsExternal: boolean
): ToolCallPlan["exactEffects"] {
  const effects: ToolCallPlan["exactEffects"] = [writes ? "process.spawn" : "process.spawn.readonly"];
  if (readsSkillResource || readsExternal) effects.push("filesystem.read");
  if (readsExternal) effects.push("filesystem.read.external");
  if (writes) effects.push("filesystem.write");
  if (validation) effects.push("validation");
  if (networkMode !== "none") effects.push("network");
  return effects;
}

function skillReference(input: Record<string, JsonValue>): { qualifiedName: string; relativePath: string } | undefined {
  const qualifiedName = input.skill;
  const relativePath = input.skillScript;
  if (qualifiedName === undefined && relativePath === undefined) return undefined;
  if (typeof qualifiedName !== "string" || !/^(home|workspace):[a-z0-9][a-z0-9._-]{0,63}$/u.test(qualifiedName)
    || typeof relativePath !== "string" || !relativePath) {
    throw Object.assign(new Error("skill and skillScript must be supplied together using a qualified skill name and relative resource path."), {
      code: "skill_resource_invalid"
    });
  }
  return { qualifiedName, relativePath };
}

export async function loadedSkillResource(
  input: Record<string, JsonValue>,
  runtimeControl: ToolPreparationContext["runtimeControl"],
  purpose: "plan" | "execute"
): Promise<LoadedSkillResourceAccess | undefined> {
  const reference = skillReference(input);
  if (!reference) return undefined;
  if (!runtimeControl) {
    throw Object.assign(new Error("Skill resource execution requires session-bound runtime control."), {
      code: "skill_execution_unavailable"
    });
  }
  return await runtimeControl.resolveLoadedSkillResource({ ...reference, purpose });
}

function readScopeError(message: string): Error {
  return Object.assign(new Error(message), { code: "policy_denied" });
}

function portableWorkspacePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target).split(path.sep).join("/");
  return relative || ".";
}

async function stableReadDirectory(
  workspaceRoot: string,
  requested: string,
  readScope: ExecutionToolOptions["readScope"]
): Promise<string> {
  const lexical = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspaceRoot, requested);
  const workspacePath = isInside(workspaceRoot, lexical);
  if (!workspacePath && readScope !== "host") {
    throw readScopeError(`Process read root escapes the workspace: ${requested}.`);
  }
  const traversalRoot = workspacePath ? workspaceRoot : path.parse(lexical).root;
  const segments = path.relative(traversalRoot, lexical).split(path.sep).filter(Boolean);
  let current = traversalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) throw readScopeError(`Process read roots must already exist: ${requested}.`);
    if (info.isSymbolicLink()) {
      throw readScopeError(`Process read roots cannot traverse links: ${requested}.`);
    }
  }
  const info = await lstat(lexical).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw readScopeError(`Process read roots must be stable existing directories: ${requested}.`);
  }
  if (!workspacePath) return lexical;
  const resolved = await resolveWorkspacePath(workspaceRoot, requested).catch((error) => {
    throw readScopeError(
      `Invalid process read root '${requested}': ${error instanceof Error ? error.message : String(error)}`
    );
  });
  return portableWorkspacePath(workspaceRoot, resolved);
}

async function plannedReadPaths(
  input: Record<string, JsonValue>,
  workspacePath: string,
  skillResource: LoadedSkillResourceAccess | undefined
): Promise<string[]> {
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length === 0)) {
    throw readScopeError("cwd must be a non-empty workspace directory path.");
  }
  const workspaceRoot = await resolveWorkspacePath(workspacePath, ".");
  // cwd is a launch location, not a read grant. Trusted workspace commands
  // receive the workspace lease; toolchain/runtime roots are added by the
  // broker from its trusted manifest and are never model-addressable.
  if (typeof input.cwd === "string") {
    await stableReadDirectory(workspaceRoot, input.cwd, "workspace");
  }
  const paths = ["."];
  if (skillResource) paths.push(skillResource.readRoot, skillResource.absolutePath);
  return [...new Set(paths)];
}

function plannedProcessMode(
  input: Record<string, JsonValue>,
  background: boolean
): ToolCallPlan["processMode"] {
  if (!background) return "pipe";
  return input.pty === true ? "pty" : "background";
}

function executionInvocation(input: Record<string, JsonValue>): ExecutionIntentV1["invocation"] {
  const executable = typeof input.executable === "string"
    ? input.executable
    : typeof input.shell === "string" ? input.shell : "";
  const args = Array.isArray(input.args)
    ? input.args.filter((item): item is string => typeof item === "string")
    : typeof input.command === "string" ? [input.command] : [];
  return {
    executable,
    args,
    cwd: typeof input.cwd === "string" ? input.cwd : "."
  };
}

function executionPurpose(
  invocation: ExecutionIntentV1["invocation"],
  validation: boolean,
  background: boolean,
  shellCommand?: string
): ExecutionIntentV1["purpose"] {
  if (background) return "serve";
  return executionCommandSemantics({
    executable: invocation.executable,
    args: invocation.args,
    validation,
    ...(shellCommand === undefined ? {} : { shellCommand })
  }).purpose;
}

function capabilityProfile(executable: string): { id: string; dependencies: string[] } {
  const name = path.basename(executable).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
  if (["node", "npm", "npx", "pnpm", "yarn", "bun", "tsc", "vitest", "jest"].includes(name)) {
    return { id: "node-typescript", dependencies: ["node_modules"] };
  }
  if (["python", "python3", "py", "pytest"].includes(name)) {
    return { id: "python", dependencies: [".venv"] };
  }
  if (name === "git") return { id: "git", dependencies: [".git"] };
  return { id: "generic", dependencies: [] };
}

async function plannedCall(
  input: Record<string, JsonValue>,
  context: Pick<ToolPreparationContext, "runMode" | "workspacePath">,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  validation = false,
  background = false
): Promise<ToolCallPlan> {
  if (background && skillResource) {
    throw Object.assign(new Error(
      "Frozen skill resources require foreground execution so their path lease remains held until the interpreter exits."
    ), { code: "skill_execution_unavailable" });
  }
  if (background && input.pty !== undefined && options.pty === false) {
    throw Object.assign(new Error("PTY background execution is not available for this execution broker."), {
      code: "pty_unavailable"
    });
  }
  const networkMode = network(input, options);
  const mutation = await processMutationContract(input, context.workspacePath, context.runMode, background);
  if (validation && mutation.access === "write") {
    throw Object.assign(new Error(
      "Validation commands run in a disposable writable workspace and cannot declare durable expectedChanges."
    ), { code: "validation_write_contract_forbidden" });
  }
  const writes = mutation.access === "write";
  const readPaths = await plannedReadPaths(input, context.workspacePath, skillResource);
  const workspaceRoot = path.resolve(context.workspacePath);
  const readsExternal = readPaths.some((item) => path.isAbsolute(item)
    && !isInside(workspaceRoot, path.resolve(item))
    && (!skillResource || !isInside(skillResource.readRoot, path.resolve(item))));
  const invocation = executionInvocation(input);
  const workspaceExecutableRoots = await ociWorkspaceExecutableRoots(
    invocation,
    workspaceRoot,
    options
  );
  const shellCommand = typeof input.command === "string" ? input.command : undefined;
  const profile = capabilityProfile(invocation.executable);
  return {
    exactEffects: plannedEffects(
      writes, validation, networkMode, Boolean(skillResource), readsExternal
    ),
    readPaths,
    writePaths: mutation.expectedChanges,
    network: networkMode,
    processMode: plannedProcessMode(input, background),
    checkpointScope: mutation.writeRoots,
    idempotence: validation && !writes ? "replay_safe" : "non_replayable",
    executionIntent: {
      invocation,
      access: mutation.access,
      ...(mutation.expectedChanges.length > 0 ? { expectedChanges: mutation.expectedChanges } : {}),
      network: networkMode,
      purpose: executionPurpose(invocation, validation, background, shellCommand)
    },
    executionCapability: {
      profileId: profile.id,
      traversalRoots: [invocation.cwd],
      workspaceReadRoots: ["."],
      dependencyRoots: profile.dependencies,
      runtimeRoots: workspaceExecutableRoots,
      writeRoots: mutation.writeRoots,
      tempRoots: [],
      network: networkMode,
      backend: options.executionBackend ?? "native"
    }
  };
}

function planSignature(plan: ToolCallPlan): string {
  return JSON.stringify({
    exactEffects: plan.exactEffects,
    readPaths: plan.readPaths,
    writePaths: plan.writePaths,
    network: plan.network,
    processMode: plan.processMode,
    checkpointScope: plan.checkpointScope,
    idempotence: plan.idempotence,
    executionIntent: plan.executionIntent,
    executionCapability: plan.executionCapability
  });
}

export async function approvedProcessPlan(
  input: Record<string, JsonValue>,
  context: PlannedToolExecutionContext,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  validation: boolean,
  background = false
): Promise<ToolCallPlan> {
  const approved = context.callPlan;
  const current = await plannedCall(input, context, options, skillResource, validation, background)
    .catch((error) => {
      if (!approved) throw error;
      throw Object.assign(new Error("Process paths or policy changed after approval.", { cause: error }), {
        code: "write_plan_stale"
      });
    });
  if (!approved) {
    if (current.exactEffects.includes("filesystem.write")) {
      throw writePlanError("Mutating process execution requires its approved call plan.", "write_plan_missing");
    }
    return current;
  }
  if (planSignature(current) !== planSignature(approved)) {
    throw writePlanError("Process paths or policy changed after approval.", "write_plan_stale");
  }
  return approved;
}

export async function prepareExecutionCallPlan(
  argumentsValue: JsonValue,
  context: Pick<ToolPreparationContext, "runMode" | "workspacePath" | "runtimeControl">,
  options: ExecutionToolOptions,
  validation = false,
  background = false
): Promise<ToolCallPlan> {
  const input = executionArgs(argumentsValue);
  if (input.executable !== undefined) assertAvailableExecutable(input, options);
  const skillResource = await loadedSkillResource(input, context.runtimeControl, "plan");
  return await plannedCall(input, context, options, skillResource, validation, background);
}

export function executionPolicy(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan,
  options: ExecutionToolOptions,
  writeRoots: string[] = [],
  skillResource?: LoadedSkillResourceAccess,
  disposableValidation = false,
  scratchLease?: ScratchLeaseV1
): ExecutionPolicy {
  const networkMode = plan.network;
  const workspaceRoot = path.resolve(context.workspacePath);
  const skillRoot = skillResource ? path.resolve(skillResource.readRoot) : undefined;
  const readRoots = plan.readPaths.flatMap((item) => {
    const resolved = path.isAbsolute(item) ? path.resolve(item) : path.resolve(workspaceRoot, item);
    if (isInside(workspaceRoot, resolved)) return [resolved];
    if (skillRoot && isInside(skillRoot, resolved)) return [];
    if (options.readScope === "host" && context.approval?.externalReadApproved === true) return [resolved];
    throw readScopeError(`Approved external process read path lacks a fresh grant: ${item}.`);
  });
  return {
    sandbox: "required",
    network: networkMode,
    networkApproved: networkMode === "full" && context.approval?.networkApproved === true,
    readRoots: [...new Set([
      ...readRoots,
      ...(skillRoot ? [skillRoot] : [])
    ])],
    writeRoots: context.runMode === "change" ? writeRoots : [],
    ...(options.executionBackend === "oci" && plan.executionCapability?.runtimeRoots.length
      ? { executionRoots: [...plan.executionCapability.runtimeRoots] }
      : {}),
    // The broker derives metadata guards from the minimal declared roots.
    // Adding workspace-root metadata here would make a narrow cwd/read scope
    // fail native root validation before the command can start.
    protectedPaths: [
      ...(skillResource ? [path.resolve(skillResource.readRoot)] : [])
    ],
    ...validationWorkspacePolicy(disposableValidation, workspaceRoot, options),
    ...(scratchLease ? { scratchLease } : {})
  };
}

export async function resolvedWriteRoots(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan
): Promise<string[]> {
  if (context.runMode !== "change") return [];
  if (!plan.exactEffects.includes("filesystem.write")) return [];
  const capabilityRoots = plan.executionCapability?.writeRoots;
  if (!plan.exactEffects.includes("process.spawn")
    || plan.processMode === "none"
    || plan.executionIntent?.access !== "write"
    || !capabilityRoots
    || capabilityRoots.length !== plan.checkpointScope.length
    || capabilityRoots.some((item, index) => item !== plan.checkpointScope[index])) {
    throw writePlanError(
      "Process checkpoint scope no longer matches its runtime-derived write capability.",
      "write_plan_stale"
    );
  }
  // expectedChanges/writePaths describe expected evidence. The sandbox lease
  // must cover the complete trusted checkpoint scope so any generator output
  // is both contained and recoverable.
  const roots = await Promise.all(plan.checkpointScope.map(async (item) =>
    await resolveWorkspacePath(context.workspacePath, item)
  ));
  for (const root of roots) {
    const relative = path.relative(path.resolve(context.workspacePath), root);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.some((segment) => segment === ".git" || segment === ".agent")) {
      throw Object.assign(new Error("Process writeRoots cannot include .git or .agent metadata."), {
        code: "policy_denied"
      });
    }
  }
  return [...new Set(roots)];
}
