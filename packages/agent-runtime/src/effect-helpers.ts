import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import {
  type JsonValue, type ModelGateway, type ModelToolCall, type ModelToolDefinition,
  type ToolCallPlan, type ToolDescriptor, type ToolReceipt, type WorkspaceDelta
} from "agent-protocol";
import { planContext, type ContextPlan, type PlanContextOptions } from "agent-context";
import { canonicalWorkspacePath, isInside, resolveWorkspacePath } from "agent-platform";
import type { RuntimeSession } from "./types.js";
import { failed } from "./tool-receipt.js";

export {
  completionFailure,
  completionPlan,
  completionPlanError,
  currentRunEvidence
} from "./completion-evidence-gate.js";
export { failed } from "./tool-receipt.js";

export function modelTools(descriptors: readonly ToolDescriptor[]): ModelToolDefinition[] {
  return descriptors.map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema }));
}

export interface ModelToolProjectionCapabilities {
  skillsAvailable: boolean;
  executableSkillResourcesLoaded: boolean;
  gitAvailable?: boolean;
  lspAvailable?: boolean;
}

/** Frozen sessions never acquire capabilities from changed live state.
 * Legacy sessions may use current catalog entries or runtime-authored durable
 * skill snapshots, subject to their currently bound profile. */
export function sessionSkillProjectionCapabilities(input: {
  frozenCustomization?: { readonly skills: readonly { qualifiedName: string }[] };
  liveSkillDescriptors?: readonly { qualifiedName: string }[];
  loadedSkills: readonly {
    qualifiedName: string;
    executionManifestArtifactId?: string;
    executionManifestDigest?: string;
  }[];
  profileSkillNames?: readonly string[];
}): ModelToolProjectionCapabilities {
  const allowed = input.profileSkillNames ? new Set(input.profileSkillNames) : undefined;
  const candidates = input.frozenCustomization
    ? input.frozenCustomization.skills.map((skill) => skill.qualifiedName)
    : [
        ...(input.liveSkillDescriptors ?? []).map((skill) => skill.qualifiedName),
        ...input.loadedSkills.map((skill) => skill.qualifiedName)
      ];
  const available = new Set(candidates.filter((name) => !allowed || allowed.has(name)));
  return {
    skillsAvailable: available.size > 0,
    executableSkillResourcesLoaded: input.loadedSkills.some((skill) =>
      available.has(skill.qualifiedName)
      && Boolean(skill.executionManifestArtifactId && skill.executionManifestDigest)
    )
  };
}

/** Present only session-real capabilities to the model while leaving the
 * authoritative registry unchanged for durable recovery and stale-call denial. */
export function projectModelToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  capabilities: ModelToolProjectionCapabilities
): ToolDescriptor[] {
  const sessionVisible = descriptors.filter((descriptor) => {
    if (descriptor.name === "git_status" || descriptor.name === "git_diff") {
      return capabilities.gitAvailable === true;
    }
    if (descriptor.name === "lsp") return capabilities.lspAvailable === true;
    return true;
  });
  const visible = capabilities.skillsAvailable
    ? sessionVisible
    : sessionVisible.filter((descriptor) => descriptor.name !== "load_skill");
  return visible.map((descriptor) => {
    const foregroundExecution = descriptor.name === "exec" || descriptor.name === "validate";
    const unavailable = descriptor.name === "process_spawn"
      || (foregroundExecution && !capabilities.executableSkillResourcesLoaded);
    if (!unavailable) return descriptor;
    const rawProperties = descriptor.inputSchema.properties;
    if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) return descriptor;
    const properties = { ...(rawProperties as Record<string, JsonValue>) };
    delete properties.skill;
    delete properties.skillScript;
    const required = Array.isArray(descriptor.inputSchema.required)
      ? descriptor.inputSchema.required.filter((item) => item !== "skill" && item !== "skillScript")
      : undefined;
    return {
      ...descriptor,
      description: descriptor.description.replace(
        " With skill and skillScript, the frozen script is prepended to interpreter args.",
        ""
      ),
      inputSchema: {
        ...descriptor.inputSchema,
        properties,
        ...(required ? { required } : {})
      }
    };
  });
}

export async function providerSizedPlan(
  gateway: ModelGateway,
  input: Omit<PlanContextOptions, "contextWindowTokens" | "promptCache"> & { maxInputTokens?: number }
): Promise<ContextPlan> {
  const providerLimit = gateway.capabilities.contextWindowTokens;
  const { maxInputTokens, ...contextInput } = input;
  const inputLimit = Math.min(providerLimit - input.outputReserveTokens, maxInputTokens ?? providerLimit);
  // Begin with the provider window and use its tokenizer as the authority.
  // Internal context estimates are intentionally conservative and must not
  // reject a terminal turn that the provider tokenizer proves can fit.
  let planningLimit = providerLimit;
  while (planningLimit > input.outputReserveTokens) {
    const plan = planContext({
      ...contextInput,
      contextWindowTokens: planningLimit,
      promptCache: gateway.capabilities.promptCache
    });
    const tokens = await gateway.countTokens(plan.messages, input.tools);
    if (tokens <= inputLimit && tokens + input.outputReserveTokens <= providerLimit) return plan;
    const ratio = Math.min(inputLimit / Math.max(1, tokens), providerLimit / (tokens + input.outputReserveTokens));
    const next = Math.min(planningLimit - 1, Math.floor(planningLimit * ratio * 0.98));
    if (next <= input.outputReserveTokens) break;
    planningLimit = next;
  }
  throw Object.assign(new Error("Provider tokenizer could not fit mandatory context and the newest user turn."), {
    code: "context_overflow"
  });
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
