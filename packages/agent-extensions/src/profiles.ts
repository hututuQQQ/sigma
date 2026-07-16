import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelRole } from "agent-model";
import { parse as parseToml } from "smol-toml";

export type ProfilePermissionMode = "deny" | "ask" | "auto";
export type ProfileReviewMode = "off" | "advisory" | "required";
export type ProfileSource = "home" | "workspace";

export interface ProfileBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicroUsd: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxChildren: number;
  maxDepth: number;
}

export interface ProfileMutationPolicy {
  requirePlanBeforeMutation: boolean;
  checkpointBeforeMutation: boolean;
  reviewMode: ProfileReviewMode;
}

export interface ResolvedAgentProfile {
  id: string;
  description?: string;
  roleRoutes: Partial<Record<ModelRole, string>>;
  toolAllow: readonly string[] | null;
  toolDeny: readonly string[];
  skills: readonly string[];
  hooks: readonly string[];
  permissionMode: ProfilePermissionMode;
  budget: ProfileBudget;
  mutationPolicy: ProfileMutationPolicy;
  allowedChildProfiles: readonly string[];
}

export interface DiscoveredAgentProfile {
  source: ProfileSource;
  filePath: string;
  profile: ResolvedAgentProfile;
}

export interface ProfileDiscoveryRoot {
  source: ProfileSource;
  directory: string;
}

export interface FrozenAgentProfile {
  profile: Readonly<ResolvedAgentProfile>;
  canonicalJson: string;
  digest: string;
}

export const DEFAULT_PROFILE_BUDGET: Readonly<ProfileBudget> = {
  maxInputTokens: 8_000_000,
  maxOutputTokens: 1_000_000,
  maxCostMicroUsd: 50_000_000,
  maxModelTurns: 256,
  maxToolCalls: 2_048,
  maxChildren: 32,
  maxDepth: 4
};

const MODEL_ROLES: readonly ModelRole[] = [
  "orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"
];
const ROOT_KEYS = new Set([
  "id", "description", "routes", "tool_allow", "tool_deny", "skills", "hooks", "permission_mode",
  "budget", "mutation", "allowed_child_profiles"
]);
const BUDGET_KEYS = new Set([
  "max_input_tokens", "max_output_tokens", "max_cost_micro_usd", "max_model_turns",
  "max_tool_calls", "max_children", "max_depth"
]);
const MUTATION_KEYS = new Set([
  "require_plan_before_mutation", "checkpoint_before_mutation", "review_mode"
]);

export function parseAgentProfileToml(source: string, filePath = "<profile>"): ResolvedAgentProfile {
  let parsed: unknown;
  try { parsed = parseToml(source); } catch (error) {
    throw new Error(`Invalid agent profile TOML '${filePath}': ${messageOf(error)}`, { cause: error });
  }
  const root = objectValue(parsed, filePath);
  rejectUnknown(root, ROOT_KEYS, filePath);
  const id = profileId(root.id, `${filePath}.id`);
  const routes = parseRoutes(root.routes, `${filePath}.routes`);
  const budget = parseBudget(root.budget, `${filePath}.budget`);
  const mutation = parseMutationPolicy(root.mutation, `${filePath}.mutation`);
  return {
    id,
    ...(root.description === undefined ? {} : { description: stringValue(root.description, `${filePath}.description`) }),
    roleRoutes: routes,
    toolAllow: root.tool_allow === undefined ? null : uniqueStrings(root.tool_allow, `${filePath}.tool_allow`),
    toolDeny: root.tool_deny === undefined ? [] : uniqueStrings(root.tool_deny, `${filePath}.tool_deny`),
    skills: root.skills === undefined ? [] : uniqueStrings(root.skills, `${filePath}.skills`),
    hooks: root.hooks === undefined ? [] : uniqueStrings(root.hooks, `${filePath}.hooks`),
    permissionMode: enumValue(root.permission_mode ?? "ask", ["deny", "ask", "auto"], `${filePath}.permission_mode`),
    budget,
    mutationPolicy: mutation,
    allowedChildProfiles: root.allowed_child_profiles === undefined
      ? [] : uniqueStrings(root.allowed_child_profiles, `${filePath}.allowed_child_profiles`)
  };
}

export async function discoverAgentProfiles(roots: readonly ProfileDiscoveryRoot[]): Promise<DiscoveredAgentProfile[]> {
  const profiles: DiscoveredAgentProfile[] = [];
  const ids = new Map<string, string>();
  for (const root of roots) {
    for (const fileName of await tomlFiles(root.directory)) {
      const filePath = path.join(root.directory, fileName);
      const profile = parseAgentProfileToml(await readProfileFile(filePath), filePath);
      const previous = ids.get(profile.id);
      if (previous) throw new Error(`Duplicate agent profile id '${profile.id}' in '${previous}' and '${filePath}'.`);
      ids.set(profile.id, filePath);
      profiles.push({ source: root.source, filePath, profile });
    }
  }
  return profiles;
}

export function defaultProfileRoots(homeDirectory: string, workspaceDirectory: string): ProfileDiscoveryRoot[] {
  return [
    { source: "home", directory: path.join(homeDirectory, ".sigma", "profiles") },
    { source: "workspace", directory: path.join(workspaceDirectory, ".agent", "profiles") }
  ];
}

export function narrowAgentProfile(
  parent: ResolvedAgentProfile,
  requested: ResolvedAgentProfile
): ResolvedAgentProfile {
  assertPermissionNarrower(parent, requested);
  assertBudgetNarrower(parent.budget, requested.budget);
  assertRoutesNarrower(parent.roleRoutes, requested.roleRoutes);
  assertSubset(requested.skills, parent.skills, "skills");
  assertSubset(requested.allowedChildProfiles, parent.allowedChildProfiles, "allowed child profiles");
  assertSuperset(requested.hooks, parent.hooks, "hooks");
  assertMutationNarrower(parent.mutationPolicy, requested.mutationPolicy);
  const toolAllow = narrowerToolAllow(parent.toolAllow, requested.toolAllow);
  return {
    ...requested,
    roleRoutes: { ...parent.roleRoutes, ...requested.roleRoutes },
    toolAllow,
    toolDeny: [...new Set([...parent.toolDeny, ...requested.toolDeny])]
  };
}

export function freezeAgentProfile(profile: ResolvedAgentProfile): FrozenAgentProfile {
  const canonicalJson = canonicalStringify(profile);
  const clone = JSON.parse(canonicalJson) as ResolvedAgentProfile;
  return {
    profile: deepFreeze(clone),
    canonicalJson,
    digest: createHash("sha256").update(canonicalJson).digest("hex")
  };
}

function parseRoutes(value: unknown, label: string): Partial<Record<ModelRole, string>> {
  if (value === undefined) return {};
  const routes = objectValue(value, label);
  rejectUnknown(routes, new Set(MODEL_ROLES), label);
  return Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, stringValue(route, `${label}.${role}`)]));
}

function parseBudget(value: unknown, label: string): ProfileBudget {
  if (value === undefined) return { ...DEFAULT_PROFILE_BUDGET };
  const budget = objectValue(value, label);
  rejectUnknown(budget, BUDGET_KEYS, label);
  return {
    maxInputTokens: positiveInteger(budget.max_input_tokens, DEFAULT_PROFILE_BUDGET.maxInputTokens, `${label}.max_input_tokens`),
    maxOutputTokens: positiveInteger(budget.max_output_tokens, DEFAULT_PROFILE_BUDGET.maxOutputTokens, `${label}.max_output_tokens`),
    maxCostMicroUsd: positiveInteger(budget.max_cost_micro_usd, DEFAULT_PROFILE_BUDGET.maxCostMicroUsd, `${label}.max_cost_micro_usd`),
    maxModelTurns: positiveInteger(budget.max_model_turns, DEFAULT_PROFILE_BUDGET.maxModelTurns, `${label}.max_model_turns`),
    maxToolCalls: positiveInteger(budget.max_tool_calls, DEFAULT_PROFILE_BUDGET.maxToolCalls, `${label}.max_tool_calls`),
    maxChildren: positiveInteger(budget.max_children, DEFAULT_PROFILE_BUDGET.maxChildren, `${label}.max_children`, true),
    maxDepth: positiveInteger(budget.max_depth, DEFAULT_PROFILE_BUDGET.maxDepth, `${label}.max_depth`, true)
  };
}

function parseMutationPolicy(value: unknown, label: string): ProfileMutationPolicy {
  if (value === undefined) return defaultMutationPolicy();
  const policy = objectValue(value, label);
  if (Object.hasOwn(policy, "review_non_documentation_changes")) {
    throw new Error(`${label}.review_non_documentation_changes was removed in V4; use review_mode = "off", "advisory", or "required".`);
  }
  rejectUnknown(policy, MUTATION_KEYS, label);
  return {
    requirePlanBeforeMutation: booleanValue(policy.require_plan_before_mutation, true, `${label}.require_plan_before_mutation`),
    checkpointBeforeMutation: booleanValue(policy.checkpoint_before_mutation, true, `${label}.checkpoint_before_mutation`),
    reviewMode: enumValue(policy.review_mode ?? "advisory", ["off", "advisory", "required"], `${label}.review_mode`)
  };
}

function defaultMutationPolicy(): ProfileMutationPolicy {
  return {
    requirePlanBeforeMutation: true,
    checkpointBeforeMutation: true,
    reviewMode: "advisory"
  };
}

async function tomlFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readProfileFile(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Agent profile '${filePath}' is not a file.`);
  if (info.size > 1_048_576) throw new Error(`Agent profile '${filePath}' exceeds 1 MiB.`);
  return await readFile(filePath, "utf8");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a TOML table.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, known: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) throw new Error(`Unknown agent profile key '${label}.${unknown}'.`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function profileId(value: unknown, label: string): string {
  const id = stringValue(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) throw new Error(`${label} is not a valid profile id.`);
  return id;
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate values.`);
  return [...value] as string[];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

function positiveInteger(value: unknown, fallback: number, label: string, zeroAllowed = false): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || Number(result) < (zeroAllowed ? 0 : 1)) {
    throw new Error(`${label} must be a ${zeroAllowed ? "non-negative" : "positive"} integer.`);
  }
  return Number(result);
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPermissionNarrower(parent: ResolvedAgentProfile, requested: ResolvedAgentProfile): void {
  const rank: Record<ProfilePermissionMode, number> = { deny: 0, ask: 1, auto: 2 };
  if (rank[requested.permissionMode] > rank[parent.permissionMode]) throw new Error("Child profile cannot widen permission mode.");
}

function assertBudgetNarrower(parent: ProfileBudget, child: ProfileBudget): void {
  for (const key of Object.keys(parent) as Array<keyof ProfileBudget>) {
    if (child[key] > parent[key]) throw new Error(`Child profile cannot increase budget '${key}'.`);
  }
}

function assertRoutesNarrower(
  parent: Partial<Record<ModelRole, string>>,
  child: Partial<Record<ModelRole, string>>
): void {
  for (const [role, route] of Object.entries(child)) {
    const parentRoute = parent[role as ModelRole];
    if (parentRoute !== undefined && route !== parentRoute) throw new Error(`Child profile cannot replace route '${role}'.`);
  }
}

function assertSubset(child: readonly string[], parent: readonly string[], label: string): void {
  const parentValues = new Set(parent);
  const extra = child.find((value) => !parentValues.has(value));
  if (extra) throw new Error(`Child profile cannot add ${label} entry '${extra}'.`);
}

function assertSuperset(child: readonly string[], parent: readonly string[], label: string): void {
  const childValues = new Set(child);
  const removed = parent.find((value) => !childValues.has(value));
  if (removed) throw new Error(`Child profile cannot remove ${label} entry '${removed}'.`);
}

function assertMutationNarrower(parent: ProfileMutationPolicy, child: ProfileMutationPolicy): void {
  if (parent.requirePlanBeforeMutation && !child.requirePlanBeforeMutation) {
    throw new Error("Child profile cannot disable mutation policy 'requirePlanBeforeMutation'.");
  }
  if (parent.checkpointBeforeMutation && !child.checkpointBeforeMutation) {
    throw new Error("Child profile cannot disable mutation policy 'checkpointBeforeMutation'.");
  }
  const rank: Record<ProfileReviewMode, number> = { off: 0, advisory: 1, required: 2 };
  if (rank[child.reviewMode] < rank[parent.reviewMode]) {
    throw new Error("Child profile cannot weaken mutation policy 'reviewMode'.");
  }
}

function narrowerToolAllow(parent: readonly string[] | null, child: readonly string[] | null): readonly string[] | null {
  if (child === null) return parent;
  if (parent !== null) assertSubset(child, parent, "tool allow");
  return child;
}

function canonicalStringify(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, visit(child)]));
  };
  return JSON.stringify(visit(value));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
