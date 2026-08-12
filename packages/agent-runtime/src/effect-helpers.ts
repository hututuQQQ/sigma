import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type JsonValue, type ModelToolCall, type ModelToolDefinition,
  type ModelToolNamespace, type ModelToolPresentation,
  type ToolCallPlan, type ToolDescriptor, type ToolReceipt, type WorkspaceDelta
} from "agent-protocol";
import { canonicalWorkspacePath, isInside, resolveWorkspacePath } from "agent-platform";
import type { RuntimeSession } from "./types.js";
import { failed } from "./tool-receipt.js";

export {
  completionFailure
} from "./completion-evidence-gate.js";
export {
  contextCapacityFailure,
  providerSizedPlan,
  type ContextCapacityFailure
} from "./context-capacity.js";
export { failed } from "./tool-receipt.js";
export {
  projectModelToolDescriptors,
  sessionModelToolProjectionCapabilities,
  sessionSkillProjectionCapabilities,
  type ModelToolProjectionCapabilities
} from "./model-tool-projection.js";

const MODEL_TOOL_NAMESPACES = Object.freeze({
  workspace_read: {
    name: "workspace_read",
    description: "Read-only workspace, repository, code-intelligence, document, and image inspection."
  },
  workspace_write: {
    name: "workspace_write",
    description: "Structured workspace file creation, editing, patching, and deletion."
  },
  execution: {
    name: "execution",
    description: "Foreground and background command execution, validation, and process lifecycle control."
  },
  version_control: {
    name: "version_control",
    description: "Git status, diff inspection, and journaled repository transactions."
  },
  planning_state: {
    name: "planning_state",
    description: "Plans, budgets, artifacts, skills, checkpoints, and durable workspace state."
  },
  recovery: {
    name: "recovery",
    description: "Restore or confirm restoration of changes made during the current run."
  },
  delegation_review: {
    name: "delegation_review",
    description: "Subagent delegation, coordination, integration, and independent review."
  },
  user_coordination: {
    name: "user_coordination",
    description: "Request user input or report a concrete blocker."
  },
  connected_services: {
    name: "connected_services",
    description: "Network, web, MCP, and connected external-service capabilities."
  },
  additional_capabilities: {
    name: "additional_capabilities",
    description: "Additional runtime capabilities not covered by the primary namespaces."
  }
} as const satisfies Record<string, ModelToolNamespace>);

type DescriptorEffect = ToolDescriptor["possibleEffects"][number];

const PRIORITY_NAMESPACE_RULES: readonly {
  effects: readonly DescriptorEffect[];
  namespace: ModelToolNamespace;
}[] = [
  {
    effects: ["outcome.request_input", "outcome.report_blocked"],
    namespace: MODEL_TOOL_NAMESPACES.user_coordination
  },
  { effects: ["agent.spawn"], namespace: MODEL_TOOL_NAMESPACES.delegation_review },
  { effects: ["checkpoint.restore"], namespace: MODEL_TOOL_NAMESPACES.recovery }
];

const GENERAL_NAMESPACE_RULES: readonly {
  effects: readonly DescriptorEffect[];
  namespace: ModelToolNamespace;
}[] = [
  {
    effects: ["process.spawn", "process.spawn.readonly", "process.handoff", "validation"],
    namespace: MODEL_TOOL_NAMESPACES.execution
  },
  {
    effects: ["network", "open_world"],
    namespace: MODEL_TOOL_NAMESPACES.connected_services
  },
  {
    effects: ["filesystem.write", "repository.write", "destructive"],
    namespace: MODEL_TOOL_NAMESPACES.workspace_write
  },
  {
    effects: ["filesystem.read", "filesystem.read.external"],
    namespace: MODEL_TOOL_NAMESPACES.workspace_read
  },
  { effects: ["runtime.control"], namespace: MODEL_TOOL_NAMESPACES.planning_state }
];

function namespaceFromEffects(
  effects: ReadonlySet<DescriptorEffect>,
  rules: typeof PRIORITY_NAMESPACE_RULES
): ModelToolNamespace | undefined {
  return rules.find((rule) => rule.effects.some((effect) => effects.has(effect)))?.namespace;
}

function inferredModelToolNamespace(descriptor: ToolDescriptor): ModelToolNamespace {
  const effects = new Set(descriptor.possibleEffects);
  const priority = namespaceFromEffects(effects, PRIORITY_NAMESPACE_RULES);
  if (priority) return priority;
  if (descriptor.resourceKeys.some((key) =>
    key.includes("git") || key.includes("repository"))) {
    return MODEL_TOOL_NAMESPACES.version_control;
  }
  return namespaceFromEffects(effects, GENERAL_NAMESPACE_RULES)
    ?? MODEL_TOOL_NAMESPACES.additional_capabilities;
}

export function modelToolPresentation(descriptor: ToolDescriptor): ModelToolPresentation {
  return {
    exposure: descriptor.modelPresentation?.exposure ?? "deferred",
    namespace: descriptor.modelPresentation?.namespace
      ?? inferredModelToolNamespace(descriptor)
  };
}

function canonicalJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]));
  }
  return value;
}

export function modelTools(descriptors: readonly ToolDescriptor[]): ModelToolDefinition[] {
  return [...descriptors]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => ({
      name: item.name,
      description: item.description,
      inputSchema: canonicalJsonValue(item.inputSchema) as ModelToolDefinition["inputSchema"],
      presentation: modelToolPresentation(item)
    }));
}

export function requestTargets(call: ModelToolCall, descriptor: ToolDescriptor): string[] {
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return [];
  const input = call.arguments as Record<string, JsonValue>;
  return (descriptor.contextPathArguments ?? []).flatMap((key) => typeof input[key] === "string" ? [input[key] as string] : []);
}

export function porcelainEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3).replaceAll("\\", "/");
    if (file && file !== ".agent" && !file.startsWith(".agent/")) entries.set(file, status);
    if (status.includes("R")) index += 1;
  }
  return entries;
}

export async function fileFingerprint(workspace: string, file: string): Promise<string> {
  try {
    const target = await resolveWorkspacePath(workspace, file);
    const info = await stat(target);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return `${info.size}:${info.mtimeMs}`;
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch {
    return "missing";
  }
}

export function workspaceDelta(before: Map<string, string>, after: Map<string, string>): WorkspaceDelta {
  const result: WorkspaceDelta = { added: [], modified: [], deleted: [] };
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const beforeStatus = before.get(file);
    const afterStatus = after.get(file);
    if (beforeStatus === afterStatus) continue;
    if (afterStatus === undefined) {
      const priorCode = beforeStatus?.slice(0, 2) ?? "";
      if (priorCode === "??" || priorCode.includes("A")) result.deleted.push(file);
      else result.modified.push(file);
    } else if (afterStatus.slice(0, 2) === "??" || afterStatus.slice(0, 2).includes("A")) result.added.push(file);
    else if (afterStatus.slice(0, 2).includes("D")) result.deleted.push(file);
    else result.modified.push(file);
  }
  result.added.sort();
  result.modified.sort();
  result.deleted.sort();
  return result;
}

export function mergeDelta(left: WorkspaceDelta | undefined, right: WorkspaceDelta): WorkspaceDelta {
  const merge = (key: keyof WorkspaceDelta): string[] => [...new Set([...(left?.[key] ?? []), ...right[key]])].sort();
  return { added: merge("added"), modified: merge("modified"), deleted: merge("deleted") };
}

const scopedMutationEffects = new Set(["filesystem.write", "repository.write", "process.spawn", "destructive", "open_world"]);

function needsWriteScope(plan: ToolCallPlan | undefined, descriptor: ToolDescriptor): boolean {
  return (plan?.exactEffects ?? descriptor.possibleEffects).some((effect) => scopedMutationEffects.has(effect));
}

function structuredArguments(call: ModelToolCall): Record<string, JsonValue> | null {
  const value = call.arguments;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function scopedWriteTargets(
  plan: ToolCallPlan | undefined,
  descriptor: ToolDescriptor,
  input: Record<string, JsonValue>
): string[] {
  if (plan) return [...new Set([...plan.writePaths, ...plan.checkpointScope])];
  return (descriptor.writePathArguments ?? []).flatMap((key) =>
    typeof input[key] === "string" ? [input[key] as string] : []);
}

async function implicitMissingCheckpointScope(
  session: RuntimeSession,
  plan: ToolCallPlan,
  target: string,
  canonical: string,
  scopes: readonly string[]
): Promise<boolean> {
  if (plan.checkpointAction || plan.processMode !== "none"
    || plan.exactEffects.includes("destructive") || plan.exactEffects.includes("open_world")
    || !plan.checkpointScope.includes(target) || plan.writePaths.includes(target)) return false;
  const state = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (state) return false;
  const writes = await Promise.all(plan.writePaths.map(async (item) =>
    await canonicalWorkspacePath(session.identity.workspacePath, item).catch(() => null)));
  return writes.some((write) => write && isInside(canonical, write)
    && scopes.some((scope) => isInside(scope, write)));
}

export async function writeScopeFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string,
  plan?: ToolCallPlan
): Promise<ToolReceipt | null> {
  if (plan?.mutationAuthority === "disposable_enclosing_container") {
    const workspaceWritePaths =
      plan.writePaths.filter((item) => !path.isAbsolute(item));
    const workspaceCheckpointScope =
      plan.checkpointScope.filter((item) => !path.isAbsolute(item));
    if (workspaceWritePaths.length === 0
      && workspaceCheckpointScope.length === 0) return null;
    plan = {
      ...plan,
      writePaths: workspaceWritePaths,
      checkpointScope: workspaceCheckpointScope,
      mutationAuthority: undefined
    };
  }
  if (!session.identity.strictWriteScope || !needsWriteScope(plan, descriptor)) return null;
  const input = structuredArguments(call);
  if (!input) return failed(call, startedAt, "Scoped writer tools require structured path arguments.", "write_scope_denied");
  const targets = scopedWriteTargets(plan, descriptor, input);
  if (targets.length === 0) return failed(call, startedAt, `Tool '${call.name}' can write outside declared paths and is disabled in an exclusive shared workspace.`, "write_scope_denied");
  const scopes = await Promise.all(session.identity.writeScope.map(async (scope) =>
    await canonicalWorkspacePath(session.identity.workspacePath, scope)));
  const outside: string[] = [];
  for (const target of targets) {
    const canonical = await canonicalWorkspacePath(session.identity.workspacePath, target).catch(() => null);
    if (!canonical) {
      outside.push(target);
      continue;
    }
    if (scopes.some((scope) => isInside(scope, canonical))) continue;
    if (plan && await implicitMissingCheckpointScope(session, plan, target, canonical, scopes)) continue;
    outside.push(target);
  }
  return outside.length > 0 ? failed(call, startedAt, `Write target is outside the delegated scope: ${outside.join(", ")}.`, "write_scope_denied") : null;
}

export function lockKeys(session: RuntimeSession, descriptor: ToolDescriptor, plan?: ToolCallPlan): string[] {
  const scope = workspaceLockScope(session);
  const declared = descriptor.resourceKeys.map((key) => `${scope}:${key}`);
  const effects = plan?.exactEffects ?? descriptor.possibleEffects;
  const writer = effects.some((effect) => effect === "filesystem.write" || effect === "destructive"
    || effect === "checkpoint.restore" || effect === "open_world")
    ? [`${scope}:workspace:write`] : [];
  const resources = [...new Set([...declared, ...writer])];
  return descriptor.executionMode === "parallel" ? resources : [...resources, `${scope}:runtime:serial`];
}

export function workspaceWriteLockKey(session: RuntimeSession): string {
  return `${workspaceLockScope(session)}:workspace:write`;
}

function workspaceLockScope(session: RuntimeSession): string {
  return process.platform === "win32" ? session.identity.workspacePath.toLowerCase() : session.identity.workspacePath;
}

export function requiresInstructionReplan(descriptor: ToolDescriptor): boolean {
  const risky = new Set(["filesystem.write", "repository.write", "process.spawn", "agent.spawn", "network", "validation", "outcome.propose", "outcome.report_blocked", "outcome.request_input", "destructive", "open_world"]);
  return descriptor.possibleEffects.some((effect) => risky.has(effect));
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error("Operation cancelled.")); };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export function steeringRestart(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { code?: unknown } | undefined)?.code === "steering_restart";
}
