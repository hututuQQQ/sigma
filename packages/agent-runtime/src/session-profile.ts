import {
  freezeAgentProfile,
  narrowAgentProfile,
  restoreFrozenAgentProfile,
  type FrozenAgentProfile,
  type FrozenSessionCustomization
} from "agent-extensions";
import type { BudgetLimits, ModelExecutionRole, RunMode } from "agent-protocol";
import type { RuntimeAgentProfile, RuntimeOptions, RuntimeSession } from "./types.js";

export interface SessionProfileSelection {
  profile?: FrozenAgentProfile;
  profileSource?: RuntimeAgentProfile["source"];
}

export function roleForMode(mode: RunMode): ModelExecutionRole {
  return mode === "change" ? "child_write" : "child_analyze";
}

export function resolveHookProfile(
  options: RuntimeOptions,
  session: RuntimeSession,
  profileId: string
): FrozenAgentProfile | undefined {
  if (session.services.profile?.profile.id === profileId) return session.services.profile;
  const frozen = session.durable.frozenCustomization?.profiles.find((item) => item.id === profileId);
  if (frozen) return restoreFrozenAgentProfile(frozen.canonicalJson, frozen.digest);
  return options.availableProfiles?.find((item) => item.profile.profile.id === profileId)?.profile;
}

export function profileBudgetLimits(profile: FrozenAgentProfile): BudgetLimits {
  const budget = profile.profile.budget;
  return {
    inputTokens: budget.maxInputTokens,
    outputTokens: budget.maxOutputTokens,
    costMicroUsd: budget.maxCostMicroUsd,
    modelTurns: budget.maxModelTurns,
    toolCalls: budget.maxToolCalls,
    children: budget.maxChildren,
    maxDepth: budget.maxDepth
  };
}

export function constrainBudget(
  allocated: BudgetLimits | undefined,
  profile: FrozenAgentProfile | undefined
): BudgetLimits | undefined {
  if (!profile) return allocated;
  const limit = profileBudgetLimits(profile);
  if (!allocated) return limit;
  return {
    inputTokens: Math.min(allocated.inputTokens, limit.inputTokens),
    outputTokens: Math.min(allocated.outputTokens, limit.outputTokens),
    costMicroUsd: Math.min(allocated.costMicroUsd, limit.costMicroUsd),
    modelTurns: Math.min(allocated.modelTurns, limit.modelTurns),
    toolCalls: Math.min(allocated.toolCalls, limit.toolCalls),
    children: Math.min(allocated.children, limit.children),
    maxDepth: Math.min(allocated.maxDepth, limit.maxDepth)
  };
}

export function resolveChildProfile(
  options: RuntimeOptions,
  parent: RuntimeSession,
  requestedProfileId: string | null | undefined
): SessionProfileSelection {
  const requested = requestedProfileId?.trim();
  if (requestedProfileId !== undefined && requestedProfileId !== null && !requested) {
    throw profileError("child_profile_invalid", "Child Agent Profile id must be non-empty.");
  }
  if (!requested || requested === parent.services.profile?.profile.id) {
    return parent.services.profile
      ? { profile: parent.services.profile, profileSource: parent.services.profileSource ?? "builtin" }
      : {};
  }
  if (!parent.services.profile) {
    throw profileError("child_profile_denied", "A child Agent Profile cannot be selected without a frozen parent profile.");
  }
  if (!parent.services.profile.profile.allowedChildProfiles.includes(requested)) {
    throw profileError(
      "child_profile_denied",
      `Agent Profile '${requested}' is not allowed by frozen parent profile '${parent.services.profile.profile.id}'.`
    );
  }
  return resolveAllowedChildProfile(options, parent, requested);
}

function resolveAllowedChildProfile(
  options: RuntimeOptions,
  parent: RuntimeSession,
  requested: string
): SessionProfileSelection {
  const frozen = parent.durable.frozenCustomization?.profiles.find((item) => item.id === requested);
  const candidate: RuntimeAgentProfile | undefined = frozen ? {
    profile: restoreFrozenAgentProfile(frozen.canonicalJson, frozen.digest),
    source: frozen.source
  } : options.availableProfiles?.find((item) => item.profile.profile.id === requested);
  if (!candidate) throw profileError("child_profile_unknown", `Unknown child Agent Profile '${requested}'.`);
  try {
    return {
      profile: freezeAgentProfile(narrowAgentProfile(parent.services.profile!.profile, candidate.profile.profile)),
      profileSource: candidate.source
    };
  } catch (error) {
    throw profileError(
      "child_profile_widening",
      `Child Agent Profile '${requested}' is not a valid narrowing: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

export function assertProfileResources(options: RuntimeOptions, profile: FrozenAgentProfile | undefined): void {
  if (!profile) return;
  const hookIds = new Set((options.hooks ?? []).map((hook) => hook.id));
  const missingHook = profile.profile.hooks.find((id) => !hookIds.has(id));
  if (missingHook) throw profileError("profile_resource_missing", `Agent Profile hook '${missingHook}' is unavailable.`);
  const skillIds = new Set<string>((options.skills?.descriptors ?? []).map((skill) => skill.qualifiedName));
  const missingSkill = profile.profile.skills.find((id) => !skillIds.has(id));
  if (missingSkill) throw profileError("profile_resource_missing", `Agent Profile skill '${missingSkill}' is unavailable.`);
}

export function assertFrozenProfileResources(
  profile: FrozenAgentProfile | undefined,
  customization: FrozenSessionCustomization | undefined
): void {
  if (!profile) return;
  if (!customization) throw profileError(
    "profile_resource_missing",
    `Frozen Agent Profile '${profile.profile.id}' has no frozen customization artifact.`
  );
  const hookIds = new Set(customization.hooks.map((item) => item.id));
  const missingHook = profile.profile.hooks.find((id) => !hookIds.has(id));
  if (missingHook) throw profileError("profile_resource_missing", `Frozen Agent Profile hook '${missingHook}' is unavailable.`);
  if (customization.schemaVersion >= 2) {
    const profileIds = new Set(customization.profiles.map((item) => item.id));
    const missingTarget = customization.hooks.find((item) =>
      item.definition.kind === "agent_profile" && !profileIds.has(item.definition.profileId));
    if (missingTarget?.definition.kind === "agent_profile") {
      throw profileError(
        "profile_resource_missing",
        `Frozen agent-profile hook '${missingTarget.id}' target '${missingTarget.definition.profileId}' is unavailable.`
      );
    }
  }
  const skillIds = new Set<string>(customization.skills.map((item) => item.qualifiedName));
  const missingSkill = profile.profile.skills.find((id) => !skillIds.has(id));
  if (missingSkill) throw profileError("profile_resource_missing", `Frozen Agent Profile skill '${missingSkill}' is unavailable.`);
}

function profileError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
