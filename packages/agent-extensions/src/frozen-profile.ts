import { createHash } from "node:crypto";
import type { ModelRole } from "agent-model";
import {
  freezeAgentProfile,
  type FrozenAgentProfile,
  type ProfileAssurancePolicy,
  type ProfileBudget,
  type ProfileMutationPolicy,
  type ResolvedAgentProfile
} from "./profiles.js";

const ROLES: readonly ModelRole[] = [
  "orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"
];
const ROOT_KEYS = new Set([
  "id", "description", "roleRoutes", "toolAllow", "toolDeny", "skills", "hooks", "permissionMode",
  "budget", "mutationPolicy", "assurancePolicy", "allowedChildProfiles"
]);
const BUDGET_KEYS = new Set<keyof ProfileBudget>([
  "maxInputTokens", "maxOutputTokens", "maxCostMicroUsd", "maxModelTurns", "maxToolCalls", "maxChildren", "maxDepth"
]);
const MUTATION_KEYS = new Set<keyof ProfileMutationPolicy>([
  "requirePlanBeforeMutation", "checkpointBeforeMutation", "reviewMode"
]);
const ASSURANCE_KEYS = new Set<keyof ProfileAssurancePolicy>([
  "budgetPercent", "reviewRounds", "repairRounds", "reviewerMaxTurns",
  "reviewerMaxToolCalls", "repairMaxTurns", "repairMaxToolCalls",
  "strategistMode", "duplicateThreshold", "strategyRemainingPercent"
]);

/** Restores only the canonical, digest-bound profile artifact emitted at session creation. */
export function restoreFrozenAgentProfile(canonicalJson: string, expectedDigest: string): FrozenAgentProfile {
  if (Buffer.byteLength(canonicalJson, "utf8") > 1_048_576) throw new Error("Frozen Agent Profile exceeds 1 MiB.");
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error("Frozen Agent Profile digest is invalid.");
  const actualDigest = createHash("sha256").update(canonicalJson).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error("Frozen Agent Profile artifact digest does not match its event.");
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalJson); } catch (error) {
    throw new Error(`Frozen Agent Profile is not valid JSON: ${messageOf(error)}`, { cause: error });
  }
  const profile = profileValue(parsed);
  const restored = freezeAgentProfile(profile);
  if (restored.canonicalJson !== canonicalJson
    || createHash("sha256").update(canonicalJson).digest("hex") !== expectedDigest) {
    throw new Error("Frozen Agent Profile artifact is not in canonical form.");
  }
  return restored;
}

function profileValue(value: unknown): ResolvedAgentProfile {
  const root = object(value, "frozen Agent Profile");
  allowedKeys(root, ROOT_KEYS, "frozen Agent Profile");
  const required = [...ROOT_KEYS].filter((key) => key !== "description");
  const missing = required.find((key) => !(key in root));
  if (missing) throw new Error(`Frozen Agent Profile 'frozen Agent Profile' has missing key '${missing}'.`);
  const routes = object(root.roleRoutes, "roleRoutes");
  allowedKeys(routes, new Set(ROLES), "roleRoutes");
  return {
    id: id(root.id, "id"),
    ...(root.description === undefined ? {} : { description: text(root.description, "description") }),
    roleRoutes: Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, text(route, `roleRoutes.${role}`)])),
    toolAllow: root.toolAllow === null ? null : strings(root.toolAllow, "toolAllow"),
    toolDeny: strings(root.toolDeny, "toolDeny"),
    skills: strings(root.skills, "skills"),
    hooks: strings(root.hooks, "hooks"),
    permissionMode: oneOf(root.permissionMode, ["deny", "ask", "auto"], "permissionMode"),
    budget: budgetValue(root.budget),
    mutationPolicy: mutationValue(root.mutationPolicy),
    assurancePolicy: assuranceValue(root.assurancePolicy),
    allowedChildProfiles: strings(root.allowedChildProfiles, "allowedChildProfiles")
  };
}

function budgetValue(value: unknown): ProfileBudget {
  const budget = object(value, "budget");
  exactKeys(budget, BUDGET_KEYS, "budget");
  return {
    maxInputTokens: integer(budget.maxInputTokens, "budget.maxInputTokens"),
    maxOutputTokens: integer(budget.maxOutputTokens, "budget.maxOutputTokens"),
    maxCostMicroUsd: integer(budget.maxCostMicroUsd, "budget.maxCostMicroUsd"),
    maxModelTurns: integer(budget.maxModelTurns, "budget.maxModelTurns"),
    maxToolCalls: integer(budget.maxToolCalls, "budget.maxToolCalls"),
    maxChildren: integer(budget.maxChildren, "budget.maxChildren", true),
    maxDepth: integer(budget.maxDepth, "budget.maxDepth", true)
  };
}

function mutationValue(value: unknown): ProfileMutationPolicy {
  const mutation = object(value, "mutationPolicy");
  exactKeys(mutation, MUTATION_KEYS, "mutationPolicy");
  return {
    requirePlanBeforeMutation: bool(mutation.requirePlanBeforeMutation, "mutationPolicy.requirePlanBeforeMutation"),
    checkpointBeforeMutation: bool(mutation.checkpointBeforeMutation, "mutationPolicy.checkpointBeforeMutation"),
    reviewMode: oneOf(mutation.reviewMode, ["off", "advisory", "required"], "mutationPolicy.reviewMode")
  };
}

function assuranceValue(value: unknown): ProfileAssurancePolicy {
  const assurance = object(value, "assurancePolicy");
  exactKeys(assurance, ASSURANCE_KEYS, "assurancePolicy");
  return {
    budgetPercent: bounded(assurance.budgetPercent, "assurancePolicy.budgetPercent", 1, 100),
    reviewRounds: bounded(assurance.reviewRounds, "assurancePolicy.reviewRounds", 1, 8),
    repairRounds: bounded(assurance.repairRounds, "assurancePolicy.repairRounds", 0, 4),
    reviewerMaxTurns: bounded(assurance.reviewerMaxTurns, "assurancePolicy.reviewerMaxTurns", 1, 32),
    reviewerMaxToolCalls: bounded(assurance.reviewerMaxToolCalls, "assurancePolicy.reviewerMaxToolCalls", 0, 128),
    repairMaxTurns: bounded(assurance.repairMaxTurns, "assurancePolicy.repairMaxTurns", 1, 32),
    repairMaxToolCalls: bounded(assurance.repairMaxToolCalls, "assurancePolicy.repairMaxToolCalls", 0, 128),
    strategistMode: oneOf(
      assurance.strategistMode,
      ["off", "on_demand", "adaptive"],
      "assurancePolicy.strategistMode"
    ),
    duplicateThreshold: bounded(assurance.duplicateThreshold, "assurancePolicy.duplicateThreshold", 2, 16),
    strategyRemainingPercent: bounded(
      assurance.strategyRemainingPercent,
      "assurancePolicy.strategyRemainingPercent",
      1,
      100
    )
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Frozen Agent Profile '${label}' must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  allowedKeys(value, keys, label);
  const missing = [...keys].find((key) => !(key in value) && key !== "description");
  if (missing) throw new Error(`Frozen Agent Profile '${label}' has missing key '${missing}'.`);
}
function allowedKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Frozen Agent Profile '${label}' has unknown key '${unknown}'.`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Frozen Agent Profile '${label}' must be non-empty text.`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(result)) throw new Error(`Frozen Agent Profile '${label}' is invalid.`);
  return result;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()) || new Set(value).size !== value.length) {
    throw new Error(`Frozen Agent Profile '${label}' must contain unique non-empty strings.`);
  }
  return [...value] as string[];
}
function integer(value: unknown, label: string, zero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) throw new Error(`Frozen Agent Profile '${label}' is invalid.`);
  return Number(value);
}
function bounded(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Frozen Agent Profile '${label}' is invalid.`);
  }
  return Number(value);
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Frozen Agent Profile '${label}' must be boolean.`);
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`Frozen Agent Profile '${label}' is invalid.`);
  return value as T;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
