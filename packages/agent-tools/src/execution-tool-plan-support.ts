import path from "node:path";
import type {
  ExecutionIntent,
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan
} from "agent-protocol";
import { isInside } from "agent-platform";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  processMutationContract,
  writePlanError
} from "./process-mutation-contract.js";

type MutationContract = Awaited<ReturnType<typeof processMutationContract>>;

function plannedEffects(
  writes: boolean,
  validation: boolean,
  networkMode: "none" | "loopback" | "full",
  readsSkillResource: boolean,
  readsExternal: boolean
): ToolCallPlan["exactEffects"] {
  const effects: ToolCallPlan["exactEffects"] = [
    writes ? "process.spawn" : "process.spawn.readonly"
  ];
  if (readsSkillResource || readsExternal) effects.push("filesystem.read");
  if (readsExternal) effects.push("filesystem.read.external");
  if (writes) effects.push("filesystem.write");
  if (validation) effects.push("validation");
  if (networkMode !== "none") effects.push("network");
  return effects;
}

export function plannedProcessMode(
  input: Record<string, JsonValue>,
  background: boolean
): ToolCallPlan["processMode"] {
  if (!background) return "pipe";
  return input.pty === true ? "pty" : "background";
}

export function executionInvocation(
  input: Record<string, JsonValue>
): ExecutionIntent["invocation"] {
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
  invocation: ExecutionIntent["invocation"],
  validation: boolean,
  background: boolean
): ExecutionIntent["purpose"] {
  const command = [invocation.executable, ...invocation.args].join(" ").toLowerCase();
  if (background) return "serve";
  if (/\b(?:build|tsc)\b/u.test(command)) return "build";
  if (/\b(?:lint|eslint|biome|ruff)\b/u.test(command)) return "lint";
  if (/\b(?:test|vitest|jest|pytest)\b/u.test(command)) return "test";
  return validation ? "custom" : "probe";
}

export function capabilityProfile(
  executable: string
): { id: string; dependencies: string[] } {
  const name = path.basename(executable).toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
  if (["node", "npm", "npx", "pnpm", "yarn", "bun", "tsc", "vitest", "jest"]
    .includes(name)) {
    return { id: "node-typescript", dependencies: ["node_modules"] };
  }
  if (["python", "python3", "py", "pytest"].includes(name)) {
    return { id: "python", dependencies: [".venv"] };
  }
  if (name === "git") return { id: "git", dependencies: [".git"] };
  return { id: "generic", dependencies: [] };
}

export function assertBackgroundExecutionAvailable(
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  background: boolean
): void {
  if (background && skillResource) {
    throw Object.assign(new Error(
      "Frozen skill resources require foreground execution so their path lease remains held until the interpreter exits."
    ), { code: "skill_execution_unavailable" });
  }
  if (background && input.pty !== undefined && options.pty === false) {
    throw Object.assign(new Error(
      "PTY background execution is not available for this execution broker."
    ), { code: "pty_unavailable" });
  }
}

export function assertMutationExecutionAvailable(
  input: Record<string, JsonValue>,
  mutation: MutationContract,
  options: ExecutionToolOptions,
  background: boolean,
  allowEnclosingContainerDeliverable = false
): void {
  if (background
    && mutation.scope === "enclosing_container"
    && input.lifecycle === "deliverable"
    && !allowEnclosingContainerDeliverable) {
    throw writePlanError(
      "A handed-off deliverable cannot retain enclosing-container mutation authority after completion.",
      "policy_denied"
    );
  }
  if (mutation.scope === "enclosing_container"
    && options.enclosingContainerRoot !== true) {
    throw writePlanError(
      "The connected broker has not attested an enclosing disposable container.",
      "policy_denied"
    );
  }
}

export function planReadsExternal(
  readPaths: readonly string[],
  workspaceRoot: string,
  skillResource: LoadedSkillResourceAccess | undefined
): boolean {
  return readPaths.some((item) => {
    if (!path.isAbsolute(item)) return false;
    const resolved = path.resolve(item);
    if (isInside(workspaceRoot, resolved)) return false;
    return !skillResource || !isInside(skillResource.readRoot, resolved);
  });
}

export function assembledExecutionPlan(input: {
  invocation: ExecutionIntent["invocation"];
  mutation: MutationContract;
  readPaths: string[];
  networkMode: ToolCallPlan["network"];
  processMode: ToolCallPlan["processMode"];
  profile: ReturnType<typeof capabilityProfile>;
  validation: boolean;
  background: boolean;
  skillResource: LoadedSkillResourceAccess | undefined;
  readsExternal: boolean;
}): ToolCallPlan {
  const writes = input.mutation.access === "write";
  return {
    exactEffects: plannedEffects(
      writes,
      input.validation,
      input.networkMode,
      Boolean(input.skillResource),
      input.readsExternal
    ),
    readPaths: input.readPaths,
    writePaths: input.mutation.expectedChanges,
    network: input.networkMode,
    processMode: input.processMode,
    checkpointScope: input.mutation.writeRoots,
    ...(input.mutation.scope === "enclosing_container"
      ? { mutationAuthority: "disposable_enclosing_container" as const }
      : {}),
    idempotence: input.validation && !writes ? "replay_safe" : "non_replayable",
    executionIntent: {
      invocation: input.invocation,
      access: input.mutation.access,
      ...(input.mutation.expectedChanges.length > 0
        ? { expectedChanges: input.mutation.expectedChanges }
        : {}),
      network: input.networkMode,
      purpose: executionPurpose(input.invocation, input.validation, input.background)
    },
    executionCapability: {
      profileId: input.profile.id,
      traversalRoots: [input.invocation.cwd],
      workspaceReadRoots: ["."],
      dependencyRoots: input.profile.dependencies,
      runtimeRoots: [],
      writeRoots: input.mutation.writeRoots,
      tempRoots: [],
      network: input.networkMode,
      backend: "native"
    }
  };
}

export function planSignature(plan: ToolCallPlan): string {
  return JSON.stringify({
    exactEffects: plan.exactEffects,
    readPaths: plan.readPaths,
    writePaths: plan.writePaths,
    network: plan.network,
    processMode: plan.processMode,
    checkpointScope: plan.checkpointScope,
    mutationAuthority: plan.mutationAuthority,
    idempotence: plan.idempotence,
    executionIntent: plan.executionIntent,
    executionCapability: plan.executionCapability
  });
}
