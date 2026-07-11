import os from "node:os";
import {
  DEFAULT_PROFILE_BUDGET,
  HookCatalog,
  defaultHookRoots,
  defaultProfileRoots,
  defaultSkillRoots,
  discoverAgentProfiles,
  discoverHooks,
  discoverSkills,
  freezeAgentProfile,
  freezeWorkspaceHookTrust,
  narrowAgentProfile,
  workspaceCustomizationManifest,
  type FrozenAgentProfile,
  type HookDefinition,
  type RuntimeHookArtifact,
  type ProfilePermissionMode,
  type ResolvedAgentProfile,
  type SkillCatalog
} from "agent-extensions";
import type { BudgetLimits } from "agent-protocol";
import type { RuntimeAgentProfile } from "./types.js";

export interface CustomizationConfig {
  agentProfile?: string;
  permissionMode: "ask" | "auto" | "deny";
  budget?: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicroUsd: number;
    maxModelTurns: number;
    maxToolCalls: number;
    maxChildren: number;
    maxDepth: number;
  };
}

export interface RuntimeCustomization {
  profile: FrozenAgentProfile;
  profileSource: "home" | "workspace" | "builtin";
  availableProfiles: readonly RuntimeAgentProfile[];
  skills: SkillCatalog;
  budgetLimits: BudgetLimits;
  permissionMode: "ask" | "auto" | "deny";
  hookDefinitions: readonly HookDefinition[];
  hookArtifacts: readonly RuntimeHookArtifact[];
  workspaceExecutableHookIds: readonly string[];
  workspaceExecutableHookArtifacts: readonly WorkspaceExecutableHookArtifact[];
}

export interface WorkspaceExecutableHookArtifact {
  id: string;
  filePath: string;
  digest: string;
}

function qualifyProfileSkills(
  profile: ResolvedAgentProfile,
  skills: SkillCatalog
): ResolvedAgentProfile {
  const qualified = profile.skills.map((reference) => skills.resolve(reference).qualifiedName);
  const duplicate = qualified.find((reference, index) => qualified.indexOf(reference) !== index);
  if (duplicate) {
    throw new Error(`Agent Profile '${profile.id}' resolves skill '${duplicate}' more than once.`);
  }
  return { ...profile, skills: qualified };
}

function assertMandatoryMutationPolicy(profile: ResolvedAgentProfile): void {
  const disabled = Object.entries(profile.mutationPolicy)
    .find(([, enabled]) => enabled !== true)?.[0];
  if (disabled) {
    throw new Error(`Agent Profile '${profile.id}' cannot disable mandatory mutation policy '${disabled}'.`);
  }
}

function configuredBudget(config: CustomizationConfig): ResolvedAgentProfile["budget"] {
  return config.budget ? { ...config.budget } : { ...DEFAULT_PROFILE_BUDGET };
}

function builtinProfile(
  config: CustomizationConfig,
  skills: SkillCatalog,
  injectedHooks: readonly HookDefinition[]
): ResolvedAgentProfile {
  return {
    id: "standard",
    description: "Sigma Code V3 strict local coding profile",
    roleRoutes: {
      orchestrator: "default", planner: "default", reviewer: "default",
      child_analyze: "default", child_write: "default", summarizer: "default"
    },
    toolAllow: null,
    toolDeny: [],
    skills: skills.descriptors.map((item) => item.qualifiedName),
    hooks: injectedHooks.map((hook) => hook.id),
    permissionMode: config.permissionMode,
    budget: configuredBudget(config),
    mutationPolicy: {
      requirePlanBeforeMutation: true,
      checkpointBeforeMutation: true,
      reviewNonDocumentationChanges: true
    },
    allowedChildProfiles: ["standard"]
  };
}

function strictPermission(left: ProfilePermissionMode, right: ProfilePermissionMode): ProfilePermissionMode {
  const rank: Record<ProfilePermissionMode, number> = { deny: 0, ask: 1, auto: 2 };
  return rank[left] <= rank[right] ? left : right;
}

function minimumBudget(profile: ResolvedAgentProfile["budget"], configured: ResolvedAgentProfile["budget"]): BudgetLimits {
  return {
    inputTokens: Math.min(profile.maxInputTokens, configured.maxInputTokens),
    outputTokens: Math.min(profile.maxOutputTokens, configured.maxOutputTokens),
    costMicroUsd: Math.min(profile.maxCostMicroUsd, configured.maxCostMicroUsd),
    modelTurns: Math.min(profile.maxModelTurns, configured.maxModelTurns),
    toolCalls: Math.min(profile.maxToolCalls, configured.maxToolCalls),
    children: Math.min(profile.maxChildren, configured.maxChildren),
    maxDepth: Math.min(profile.maxDepth, configured.maxDepth)
  };
}

function budgetProfile(limits: BudgetLimits): ResolvedAgentProfile["budget"] {
  return {
    maxInputTokens: limits.inputTokens,
    maxOutputTokens: limits.outputTokens,
    maxCostMicroUsd: limits.costMicroUsd,
    maxModelTurns: limits.modelTurns,
    maxToolCalls: limits.toolCalls,
    maxChildren: limits.children,
    maxDepth: limits.maxDepth
  };
}

export async function resolveRuntimeCustomization(
  config: CustomizationConfig,
  workspace: string,
  homeDirectory = os.homedir(),
  injectedHooks: readonly HookDefinition[] = []
): Promise<RuntimeCustomization> {
  const [skills, discoveredHooks, discoveredProfiles] = await Promise.all([
    discoverSkills(defaultSkillRoots(homeDirectory, workspace)),
    discoverHooks(defaultHookRoots(homeDirectory, workspace)),
    discoverAgentProfiles(defaultProfileRoots(homeDirectory, workspace))
  ]);
  const profiles = discoveredProfiles.map((item) => ({
    ...item,
    profile: qualifyProfileSkills(item.profile, skills)
  }));
  for (const item of profiles) assertMandatoryMutationPolicy(item.profile);
  const hookCatalog = new HookCatalog(discoveredHooks, injectedHooks);
  const builtin = builtinProfile(config, skills, injectedHooks);
  if (profiles.some((item) => item.profile.id === builtin.id)) {
    throw new Error(`Agent Profile id '${builtin.id}' is reserved by the built-in profile.`);
  }
  const selectedId = config.agentProfile?.trim() || "standard";
  let selected = builtin;
  let profileSource: RuntimeCustomization["profileSource"] = "builtin";
  if (selectedId !== "standard") {
    const found = profiles.find((item) => item.profile.id === selectedId);
    if (!found) throw new Error(`Unknown Agent Profile '${selectedId}'.`);
    selected = found.source === "workspace" ? narrowAgentProfile(builtin, found.profile) : found.profile;
    profileSource = found.source;
  }
  const permissionMode = strictPermission(config.permissionMode, selected.permissionMode);
  const budgetLimits = minimumBudget(selected.budget, configuredBudget(config));
  const resolved = { ...selected, permissionMode, budget: budgetProfile(budgetLimits) };
  const referencedHookIds = new Set([builtin, ...profiles.map((item) => item.profile)].flatMap((item) => item.hooks));
  for (const id of referencedHookIds) hookCatalog.resolve(id);
  // Keep the complete discovered catalog available so frozen sessions can resume
  // after profile files change without reinterpreting those profile files.
  const availableHooks = hookCatalog.hooks;
  const executableWorkspaceHooks = availableHooks
    .filter((hook) => hook.source === "workspace" && hook.definition.kind === "command");
  const workspaceHookTrust = executableWorkspaceHooks.length > 0
    ? freezeWorkspaceHookTrust(workspaceCustomizationManifest(workspace)) : undefined;
  return {
    profile: freezeAgentProfile(resolved),
    profileSource,
    availableProfiles: [
      { profile: freezeAgentProfile(builtin), source: "builtin" },
      ...profiles.map((item) => ({ profile: freezeAgentProfile(item.profile), source: item.source }))
    ],
    skills,
    budgetLimits,
    permissionMode,
    hookDefinitions: availableHooks.map((hook) => hook.definition),
    hookArtifacts: availableHooks.map((hook) => ({
      definition: hook.definition,
      source: hook.filePath === "<injected>" ? "builtin" : hook.source,
      digest: hook.digest,
      ...(hook.source === "workspace" && hook.definition.kind === "command" && workspaceHookTrust
        ? { trust: workspaceHookTrust } : {})
    })),
    workspaceExecutableHookIds: executableWorkspaceHooks.map((hook) => hook.definition.id),
    workspaceExecutableHookArtifacts: executableWorkspaceHooks
      .map((hook) => ({ id: hook.definition.id, filePath: hook.filePath, digest: hook.digest }))
  };
}
