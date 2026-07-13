import path from "node:path";
import type { ExecutionPolicy } from "agent-execution";
import type {
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan,
  ToolPreparationContext
} from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import { executionArgs } from "./execution-tool-values.js";
import { processMutationContract, writePlanError } from "./process-mutation-contract.js";
import type { PlannedToolExecutionContext } from "./registry.js";

function network(input: Record<string, JsonValue>, fallback: "none" | "full"): "none" | "full" {
  const value = input.network ?? fallback;
  if (value !== "none" && value !== "full") throw new Error("network must be none or full.");
  return value;
}

function plannedEffects(
  writes: boolean,
  validation: boolean,
  networkMode: "none" | "full",
  sandboxMode: ExecutionToolOptions["sandboxMode"],
  readsSkillResource: boolean
): ToolCallPlan["exactEffects"] {
  const effects: ToolCallPlan["exactEffects"] = [writes ? "process.spawn" : "process.spawn.readonly"];
  if (readsSkillResource) effects.push("filesystem.read");
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

function plannedReadPaths(
  input: Record<string, JsonValue>,
  skillResource: LoadedSkillResourceAccess | undefined
): string[] {
  const paths = [typeof input.cwd === "string" ? input.cwd : "."];
  if (skillResource) paths.push(skillResource.readRoot, skillResource.absolutePath);
  return paths;
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
  const networkMode = network(input, options.networkMode);
  const mutation = await processMutationContract(input, context.workspacePath, context.runMode, background);
  const writes = mutation.access === "write";
  return {
    exactEffects: plannedEffects(writes, validation, networkMode, sandboxMode, Boolean(skillResource)),
    readPaths: plannedReadPaths(input, skillResource),
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
  return {
    sandbox: required ? "required" : "unsafe",
    network: networkMode,
    networkApproved: networkMode === "full" && context.approval?.networkApproved === true,
    readRoots: [...new Set([
      path.resolve(context.workspacePath),
      ...(skillResource ? [path.resolve(skillResource.readRoot)] : [])
    ])],
    writeRoots: context.runMode === "change" ? writeRoots : [],
    protectedPaths: [
      path.join(context.workspacePath, ".git"),
      path.join(context.workspacePath, ".agent"),
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
