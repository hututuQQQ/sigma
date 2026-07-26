import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPolicy, ScratchLease } from "agent-execution";
import type {
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
import { validationWorkspacePolicy } from "./execution-validation-workspace.js";
import { environmentWorkspaceMutation } from "./environment-workspace-mutation.js";
import {
  assembledExecutionPlan,
  assertBackgroundExecutionAvailable,
  assertMutationExecutionAvailable,
  capabilityProfile,
  executionInvocation,
  planReadsExternal,
  planSignature,
  plannedProcessMode
} from "./execution-tool-plan-support.js";

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
  skillResource: LoadedSkillResourceAccess | undefined,
  readScope: ExecutionToolOptions["readScope"],
  mutation: Awaited<ReturnType<typeof processMutationContract>>
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
  const declared = input.readRoots;
  if (declared !== undefined
    && (!Array.isArray(declared) || declared.some((item) => typeof item !== "string" || !item))) {
    throw readScopeError("readRoots must be an array of non-empty directory paths.");
  }
  const paths = [
    ".",
    ...await Promise.all(((declared ?? []) as string[]).map(async (item) =>
      await stableReadDirectory(workspaceRoot, item, readScope)
    )),
    ...(mutation.scope === "enclosing_container" ? mutation.writeRoots : [])
  ];
  if (skillResource) paths.push(skillResource.readRoot, skillResource.absolutePath);
  return [...new Set(paths)];
}

async function plannedCall(
  input: Record<string, JsonValue>,
  context: Pick<ToolPreparationContext, "runMode" | "workspacePath">,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  validation = false,
  background = false,
  allowEnclosingContainerDeliverable = false,
  environmentExpectedChanges?: JsonValue
): Promise<ToolCallPlan> {
  assertBackgroundExecutionAvailable(input, options, skillResource, background);
  const networkMode = network(input, options);
  const mutation = await processMutationContract(
    input,
    context.workspacePath,
    context.runMode,
    background,
    options.writeScope ?? "workspace"
  );
  assertMutationExecutionAvailable(
    input,
    mutation,
    options,
    background,
    allowEnclosingContainerDeliverable
  );
  const workspaceMutation = mutation.scope === "enclosing_container"
    ? await environmentWorkspaceMutation(
      environmentExpectedChanges,
      context.workspacePath,
      context.runMode,
      background
    )
    : undefined;
  const readPaths = await plannedReadPaths(
    input,
    context.workspacePath,
    skillResource,
    options.readScope,
    mutation
  );
  const workspaceRoot = path.resolve(context.workspacePath);
  const invocation = executionInvocation(input);
  const profile = capabilityProfile(invocation.executable);
  return assembledExecutionPlan({
    invocation,
    mutation,
    workspaceMutation,
    readPaths,
    networkMode,
    processMode: plannedProcessMode(input, background),
    profile,
    validation,
    background,
    skillResource,
    readsExternal: planReadsExternal(readPaths, workspaceRoot, skillResource)
  });
}

export async function approvedProcessPlan(
  input: Record<string, JsonValue>,
  context: PlannedToolExecutionContext,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  validation: boolean,
  background = false,
  allowEnclosingContainerDeliverable = false,
  environmentExpectedChanges?: JsonValue
): Promise<ToolCallPlan> {
  const approved = context.callPlan;
  const current = await plannedCall(
    input,
    context,
    options,
    skillResource,
    validation,
    background,
    allowEnclosingContainerDeliverable,
    environmentExpectedChanges
  )
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
  background = false,
  allowEnclosingContainerDeliverable = false,
  environmentExpectedChanges?: JsonValue
): Promise<ToolCallPlan> {
  const input = executionArgs(argumentsValue);
  if (input.executable !== undefined) assertAvailableExecutable(input, options);
  const skillResource = await loadedSkillResource(input, context.runtimeControl, "plan");
  return await plannedCall(
    input,
    context,
    options,
    skillResource,
    validation,
    background,
    allowEnclosingContainerDeliverable,
    environmentExpectedChanges
  );
}

function executionProtectedPaths(
  plan: ToolCallPlan,
  workspaceRoot: string,
  runtimeProtectedPaths: string[],
  skillResource?: LoadedSkillResourceAccess
): string[] {
  const protectedPaths = skillResource
    ? [path.resolve(skillResource.readRoot)] : [];
  if (plan.mutationAuthority !== "disposable_enclosing_container") {
    return protectedPaths;
  }
  const mutatesWorkspace =
    plan.checkpointScope.some((item) => !path.isAbsolute(item));
  return [
    ...protectedPaths,
    ...(mutatesWorkspace
      ? [
          path.join(workspaceRoot, ".git"),
          path.join(workspaceRoot, ".agent")
        ]
      : [workspaceRoot]),
    ...runtimeProtectedPaths
  ];
}

export function executionPolicy(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan,
  options: ExecutionToolOptions,
  writeRoots: string[] = [],
  skillResource?: LoadedSkillResourceAccess,
  disposableValidation = false,
  scratchLease?: ScratchLease
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
  const enclosingContainer =
    plan.mutationAuthority === "disposable_enclosing_container";
  const runtimeProtectedPaths = enclosingContainer
    ? (options.protectedPaths ?? []).map((item) => path.resolve(item))
    : [];
  return {
    sandbox: "required",
    network: networkMode,
    networkApproved: networkMode === "full" && context.approval?.networkApproved === true,
    readRoots: [...new Set([
      ...readRoots,
      ...(skillRoot ? [skillRoot] : []),
      ...runtimeProtectedPaths
    ])],
    writeRoots: context.runMode === "change" ? writeRoots : [],
    // The broker derives metadata guards from the minimal declared roots.
    // Adding workspace-root metadata here would make a narrow cwd/read scope
    // fail native root validation before the command can start.
    protectedPaths: executionProtectedPaths(
      plan,
      workspaceRoot,
      runtimeProtectedPaths,
      skillResource
    ),
    ...(enclosingContainer ? { enclosingContainerRoot: true } : {}),
    ...validationWorkspacePolicy(disposableValidation, workspaceRoot, options),
    ...(scratchLease && !enclosingContainer ? { scratchLease } : {})
  };
}

export async function resolvedWriteRoots(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan
): Promise<string[]> {
  if (context.runMode !== "change") return [];
  if (plan.mutationAuthority === "disposable_enclosing_container") {
    const enclosingRoots = plan.checkpointScope
      .filter((item) => path.isAbsolute(item))
      .map((item) => path.resolve(item));
    if (enclosingRoots.length === 0) {
      throw Object.assign(new Error(
        "Enclosing-container execution requires a canonical absolute write root."
      ), { code: "write_plan_stale" });
    }
    return [...new Set(enclosingRoots)];
  }
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
