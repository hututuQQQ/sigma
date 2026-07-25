import type { ModelRole } from "agent-model";
import type {
  ProfileAssurancePolicy,
  ProfileBudget,
  ProfileMutationPolicy,
  ProfilePermissionMode,
  ProfileReviewMode,
  ProfileStrategistMode,
  ResolvedAgentProfile
} from "./profiles.js";

function assertPermissionNarrower(
  parent: ResolvedAgentProfile,
  requested: ResolvedAgentProfile
): void {
  const rank: Record<ProfilePermissionMode, number> = { deny: 0, ask: 1, auto: 2 };
  if (rank[requested.permissionMode] > rank[parent.permissionMode]) {
    throw new Error("Child profile cannot widen permission mode.");
  }
}

function assertBudgetNarrower(parent: ProfileBudget, child: ProfileBudget): void {
  for (const key of Object.keys(parent) as Array<keyof ProfileBudget>) {
    if (child[key] > parent[key]) {
      throw new Error(`Child profile cannot increase budget '${key}'.`);
    }
  }
}

function assertRoutesNarrower(
  parent: Partial<Record<ModelRole, string>>,
  child: Partial<Record<ModelRole, string>>
): void {
  for (const [role, route] of Object.entries(child)) {
    const parentRoute = parent[role as ModelRole];
    if (parentRoute !== undefined && route !== parentRoute) {
      throw new Error(`Child profile cannot replace route '${role}'.`);
    }
  }
}

function assertSubset(
  child: readonly string[],
  parent: readonly string[],
  label: string
): void {
  const parentValues = new Set(parent);
  const extra = child.find((value) => !parentValues.has(value));
  if (extra) throw new Error(`Child profile cannot add ${label} entry '${extra}'.`);
}

function assertSuperset(
  child: readonly string[],
  parent: readonly string[],
  label: string
): void {
  const childValues = new Set(child);
  const removed = parent.find((value) => !childValues.has(value));
  if (removed) throw new Error(`Child profile cannot remove ${label} entry '${removed}'.`);
}

function assertMutationNarrower(
  parent: ProfileMutationPolicy,
  child: ProfileMutationPolicy
): void {
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

function assertAssuranceNarrower(
  parent: ProfileAssurancePolicy,
  child: ProfileAssurancePolicy
): void {
  for (const key of [
    "budgetPercent",
    "reviewRounds",
    "repairRounds",
    "reviewerMaxTurns",
    "reviewerMaxToolCalls",
    "repairMaxTurns",
    "repairMaxToolCalls"
  ] as const) {
    if (child[key] > parent[key]) {
      throw new Error(`Child profile cannot increase assurance resource '${key}'.`);
    }
  }
  const strategistRank: Record<ProfileStrategistMode, number> = {
    off: 0,
    on_demand: 1,
    adaptive: 2
  };
  if (strategistRank[child.strategistMode] > strategistRank[parent.strategistMode]) {
    throw new Error("Child profile cannot widen assurance strategist mode.");
  }
  if (child.duplicateThreshold !== parent.duplicateThreshold) {
    throw new Error("Child profile cannot reinterpret the duplicate-action threshold.");
  }
  if (child.strategyRemainingPercent > parent.strategyRemainingPercent) {
    throw new Error("Child profile cannot trigger the strategist at a wider resource band.");
  }
}

function narrowerToolAllow(
  parent: readonly string[] | null,
  child: readonly string[] | null
): readonly string[] | null {
  if (child === null) return parent;
  if (parent !== null) assertSubset(child, parent, "tool allow");
  return child;
}

export function assertProfileNarrowing(
  parent: ResolvedAgentProfile,
  requested: ResolvedAgentProfile,
  parentAssurance: ProfileAssurancePolicy,
  requestedAssurance: ProfileAssurancePolicy
): readonly string[] | null {
  assertPermissionNarrower(parent, requested);
  assertBudgetNarrower(parent.budget, requested.budget);
  assertRoutesNarrower(parent.roleRoutes, requested.roleRoutes);
  assertSubset(requested.skills, parent.skills, "skills");
  assertSubset(
    requested.allowedChildProfiles,
    parent.allowedChildProfiles,
    "allowed child profiles"
  );
  assertSuperset(requested.hooks, parent.hooks, "hooks");
  assertMutationNarrower(parent.mutationPolicy, requested.mutationPolicy);
  assertAssuranceNarrower(parentAssurance, requestedAssurance);
  return narrowerToolAllow(parent.toolAllow, requested.toolAllow);
}
