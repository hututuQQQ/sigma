import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelRole } from "agent-model";
import { parse as parseToml } from "smol-toml";
import { canonicalStringify, deepFreeze } from "./profile-canonical.js";
import { assertProfileNarrowing } from "./profile-narrowing.js";

export type ProfilePermissionMode = "deny" | "ask" | "auto";
export type ProfileReviewMode = "off" | "advisory" | "required";
export type ProfileStrategistMode = "off" | "on_demand" | "adaptive";
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

/**
 * Resource bounds for independent assurance work. Reviewer and strategist
 * values are ceilings. Repair values are capacity reserved from pre-review
 * solving; once repair starts, the ordinary hard ledger remains authoritative.
 * None of these values classify task semantics.
 */
export interface ProfileAssurancePolicy {
  budgetPercent: number;
  reviewRounds: number;
  repairRounds: number;
  reviewerMaxTurns: number;
  reviewerMaxToolCalls: number;
  repairMaxTurns: number;
  repairMaxToolCalls: number;
  strategistMode: ProfileStrategistMode;
  duplicateThreshold: number;
  strategyRemainingPercent: number;
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
  assurancePolicy: ProfileAssurancePolicy;
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

export const DEFAULT_PROFILE_ASSURANCE: Readonly<ProfileAssurancePolicy> = {
  budgetPercent: 20,
  reviewRounds: 2,
  repairRounds: 1,
  reviewerMaxTurns: 4,
  reviewerMaxToolCalls: 12,
  repairMaxTurns: 3,
  repairMaxToolCalls: 8,
  strategistMode: "adaptive",
  duplicateThreshold: 3,
  strategyRemainingPercent: 25
};

const MODEL_ROLES: readonly ModelRole[] = [
  "orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"
];
const ROOT_KEYS = new Set([
  "id", "description", "routes", "tool_allow", "tool_deny", "skills", "hooks", "permission_mode",
  "budget", "mutation", "assurance", "allowed_child_profiles"
]);
const BUDGET_KEYS = new Set([
  "max_input_tokens", "max_output_tokens", "max_cost_micro_usd", "max_model_turns",
  "max_tool_calls", "max_children", "max_depth"
]);
const MUTATION_KEYS = new Set([
  "require_plan_before_mutation", "checkpoint_before_mutation", "review_mode"
]);
const ASSURANCE_KEYS = new Set([
  "budget_percent", "review_rounds", "repair_rounds", "reviewer_max_turns",
  "reviewer_max_tool_calls", "repair_max_turns", "repair_max_tool_calls",
  "strategist_mode", "duplicate_threshold", "strategy_remaining_percent"
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
  const assurance = parseAssurancePolicy(root.assurance, `${filePath}.assurance`);
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
    assurancePolicy: assurance,
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
  // Profiles frozen before customization V4 do not carry an assurance block.
  // A missing child block inherits the parent limits; it must not silently
  // expand to the current defaults when the parent was explicitly tighter.
  const parentAssurance: ProfileAssurancePolicy = {
    ...DEFAULT_PROFILE_ASSURANCE,
    ...(parent.assurancePolicy ?? {})
  };
  const requestedAssurance: ProfileAssurancePolicy = {
    ...parentAssurance,
    ...(requested.assurancePolicy ?? {})
  };
  const toolAllow = assertProfileNarrowing(
    parent,
    requested,
    parentAssurance,
    requestedAssurance
  );
  return {
    ...requested,
    assurancePolicy: { ...requestedAssurance },
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
    requirePlanBeforeMutation: booleanValue(policy.require_plan_before_mutation, false, `${label}.require_plan_before_mutation`),
    checkpointBeforeMutation: booleanValue(policy.checkpoint_before_mutation, true, `${label}.checkpoint_before_mutation`),
    reviewMode: enumValue(policy.review_mode ?? "advisory", ["off", "advisory", "required"], `${label}.review_mode`)
  };
}

function defaultMutationPolicy(): ProfileMutationPolicy {
  return {
    requirePlanBeforeMutation: false,
    checkpointBeforeMutation: true,
    reviewMode: "advisory"
  };
}

function parseAssurancePolicy(value: unknown, label: string): ProfileAssurancePolicy {
  if (value === undefined) return { ...DEFAULT_PROFILE_ASSURANCE };
  const policy = objectValue(value, label);
  rejectUnknown(policy, ASSURANCE_KEYS, label);
  return {
    budgetPercent: boundedInteger(
      policy.budget_percent, DEFAULT_PROFILE_ASSURANCE.budgetPercent, 1, 100,
      `${label}.budget_percent`
    ),
    reviewRounds: boundedInteger(
      policy.review_rounds, DEFAULT_PROFILE_ASSURANCE.reviewRounds, 1, 8,
      `${label}.review_rounds`
    ),
    repairRounds: boundedInteger(
      policy.repair_rounds, DEFAULT_PROFILE_ASSURANCE.repairRounds, 0, 4,
      `${label}.repair_rounds`
    ),
    reviewerMaxTurns: boundedInteger(
      policy.reviewer_max_turns, DEFAULT_PROFILE_ASSURANCE.reviewerMaxTurns, 1, 32,
      `${label}.reviewer_max_turns`
    ),
    reviewerMaxToolCalls: boundedInteger(
      policy.reviewer_max_tool_calls, DEFAULT_PROFILE_ASSURANCE.reviewerMaxToolCalls, 0, 128,
      `${label}.reviewer_max_tool_calls`
    ),
    repairMaxTurns: boundedInteger(
      policy.repair_max_turns, DEFAULT_PROFILE_ASSURANCE.repairMaxTurns, 1, 32,
      `${label}.repair_max_turns`
    ),
    repairMaxToolCalls: boundedInteger(
      policy.repair_max_tool_calls, DEFAULT_PROFILE_ASSURANCE.repairMaxToolCalls, 0, 128,
      `${label}.repair_max_tool_calls`
    ),
    strategistMode: enumValue(
      policy.strategist_mode ?? DEFAULT_PROFILE_ASSURANCE.strategistMode,
      ["off", "on_demand", "adaptive"],
      `${label}.strategist_mode`
    ),
    duplicateThreshold: boundedInteger(
      policy.duplicate_threshold, DEFAULT_PROFILE_ASSURANCE.duplicateThreshold, 2, 16,
      `${label}.duplicate_threshold`
    ),
    strategyRemainingPercent: boundedInteger(
      policy.strategy_remaining_percent, DEFAULT_PROFILE_ASSURANCE.strategyRemainingPercent, 1, 100,
      `${label}.strategy_remaining_percent`
    )
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

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || Number(result) < minimum || Number(result) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
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
