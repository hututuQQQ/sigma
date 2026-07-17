import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPolicy } from "agent-execution";
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

function network(input: Record<string, JsonValue>, options: ExecutionToolOptions): "none" | "full" {
  const available = availableNetworkModes(options);
  const fallback = available.includes(options.networkMode) ? options.networkMode : available[0];
  const value = input.network ?? fallback;
  if (value !== "none" && value !== "full") throw new Error("network must be none or full.");
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
  networkMode: "none" | "full",
  sandboxMode: ExecutionToolOptions["sandboxMode"],
  readsSkillResource: boolean,
  readsExternal: boolean
): ToolCallPlan["exactEffects"] {
  const effects: ToolCallPlan["exactEffects"] = [writes ? "process.spawn" : "process.spawn.readonly"];
  if (readsSkillResource || readsExternal) effects.push("filesystem.read");
  if (readsExternal) effects.push("filesystem.read.external");
  if (writes) effects.push("filesystem.write");
  if (validation) effects.push("validation");
  if (networkMode === "full") effects.push("network");
  if (sandboxMode === "unsafe") effects.push("open_world");
  return effects;
}

function assertSafeBackgroundMode(background: boolean, sandboxMode: ExecutionToolOptions["sandboxMode"]): void {
  if (!background || sandboxMode !== "unsafe") return;
  throw Object.assign(new Error(
    "Unsafe host background processes are disabled because their lifetime cannot be covered by one sealed checkpoint."
  ), { code: "policy_denied" });
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

function declaredReadRoots(input: Record<string, JsonValue>): string[] {
  const value = input.readRoots;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw readScopeError("readRoots must be a non-empty array of directory paths.");
  }
  return [...new Set(value as string[])];
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
  options: ExecutionToolOptions
): Promise<string[]> {
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length === 0)) {
    throw readScopeError("cwd must be a non-empty workspace directory path.");
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : ".";
  const workspaceRoot = await resolveWorkspacePath(workspacePath, ".");
  const stableCwd = await stableReadDirectory(workspaceRoot, cwd, "workspace");
  const paths = [stableCwd, ...await Promise.all(
    declaredReadRoots(input).map(async (item) =>
      await stableReadDirectory(workspaceRoot, item, options.readScope)
    )
  )];
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

async function plannedCall(
  input: Record<string, JsonValue>,
  context: Pick<ToolPreparationContext, "runMode" | "workspacePath">,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  validation = false,
  background = false
): Promise<ToolCallPlan> {
  const sandboxMode = skillResource ? "required" : options.sandboxMode;
  assertSafeBackgroundMode(background, sandboxMode);
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
  const writes = mutation.access === "write";
  const readPaths = await plannedReadPaths(input, context.workspacePath, skillResource, options);
  const workspaceRoot = path.resolve(context.workspacePath);
  const readsExternal = readPaths.some((item) => path.isAbsolute(item)
    && !isInside(workspaceRoot, path.resolve(item))
    && (!skillResource || !isInside(skillResource.readRoot, path.resolve(item))));
  return {
    exactEffects: plannedEffects(
      writes, validation, networkMode, sandboxMode, Boolean(skillResource), readsExternal
    ),
    readPaths,
    writePaths: mutation.expectedChanges,
    network: networkMode,
    processMode: plannedProcessMode(input, background),
    checkpointScope: writes && sandboxMode === "unsafe" ? ["."] : mutation.writeRoots,
    idempotence: validation && !writes ? "replay_safe" : "non_replayable"
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
    idempotence: plan.idempotence
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
  skillResource?: LoadedSkillResourceAccess
): ExecutionPolicy {
  const required = Boolean(skillResource) || context.runMode === "analyze" || options.sandboxMode === "required";
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
    sandbox: required ? "required" : "unsafe",
    network: networkMode,
    networkApproved: networkMode === "full" && context.approval?.networkApproved === true,
    readRoots: [...new Set([
      ...readRoots,
      ...(skillRoot ? [skillRoot] : [])
    ])],
    writeRoots: context.runMode === "change" ? writeRoots : [],
    // The broker derives metadata guards from the minimal declared roots.
    // Adding workspace-root metadata here would make a narrow cwd/read scope
    // fail native root validation before the command can start.
    protectedPaths: [
      ...(skillResource ? [path.resolve(skillResource.readRoot)] : [])
    ],
    unsafeHostExecApproved: !required && context.approval?.unsafeHostExecApproved === true
  };
}

export async function resolvedWriteRoots(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan
): Promise<string[]> {
  if (context.runMode !== "change") return [];
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
