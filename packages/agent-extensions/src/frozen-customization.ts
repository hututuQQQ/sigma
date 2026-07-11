import { createHash } from "node:crypto";
import type { FrozenAgentProfile } from "./profiles.js";
import { restoreFrozenAgentProfile } from "./frozen-profile.js";
import type { HookDefinition } from "./hooks.js";
import { validateHookDefinitions } from "./hooks.js";
import type { SkillCatalog, SkillSource } from "./skills.js";
import {
  frozenWorkspaceHookTrustValue,
  type FrozenWorkspaceHookTrust
} from "./frozen-hook-trust.js";

export type CustomizationSource = SkillSource | "builtin";

export interface RuntimeHookArtifact {
  definition: HookDefinition;
  source: CustomizationSource;
  digest: string;
  trust?: FrozenWorkspaceHookTrust;
}

export interface FrozenSessionSkill {
  name: string;
  qualifiedName: `${SkillSource}:${string}`;
  description: string;
  source: SkillSource;
  digest: string;
  instructions: string;
}

export interface FrozenSessionHook {
  id: string;
  source: CustomizationSource;
  digest: string;
  definition: HookDefinition;
  trust?: FrozenWorkspaceHookTrust;
}

export interface FrozenSessionProfile {
  id: string;
  source: CustomizationSource;
  digest: string;
  canonicalJson: string;
}

export interface FrozenSessionCustomization {
  schemaVersion: 1 | 2 | 3;
  skills: readonly FrozenSessionSkill[];
  hooks: readonly FrozenSessionHook[];
  /** Agent Profile hook targets. Empty only for legacy schema-1 artifacts. */
  profiles: readonly FrozenSessionProfile[];
  canonicalJson: string;
  digest: string;
}

interface FreezeCustomizationInput {
  profile?: FrozenAgentProfile;
  profileSource?: CustomizationSource;
  profiles?: readonly { profile: FrozenAgentProfile; source: CustomizationSource }[];
  skills?: SkillCatalog;
  hooks?: readonly HookDefinition[];
  hookArtifacts?: readonly RuntimeHookArtifact[];
}

interface StoredCustomizationV1 {
  schemaVersion: 1;
  skills: FrozenSessionSkill[];
  hooks: FrozenSessionHook[];
}

interface StoredCustomizationV2 {
  schemaVersion: 2;
  skills: FrozenSessionSkill[];
  hooks: FrozenSessionHook[];
  profiles: FrozenSessionProfile[];
}

interface StoredCustomizationV3 {
  schemaVersion: 3;
  skills: FrozenSessionSkill[];
  hooks: FrozenSessionHook[];
  profiles: FrozenSessionProfile[];
}
type StoredCustomization = StoredCustomizationV1 | StoredCustomizationV2 | StoredCustomizationV3;

const MAX_FROZEN_CUSTOMIZATION_BYTES = 64 * 1_048_576;
const DIGEST = /^[a-f0-9]{64}$/u;
const QUALIFIED_SKILL = /^(home|workspace):[a-z0-9][a-z0-9._-]{0,63}$/u;

function freezeReferencedProfiles(
  input: FreezeCustomizationInput,
  hooks: readonly FrozenSessionHook[]
): FrozenSessionProfile[] {
  const referenced = new Set(hooks.flatMap((item) =>
    item.definition.kind === "agent_profile" ? [item.definition.profileId] : []));
  const candidates = new Map<string, { profile: FrozenAgentProfile; source: CustomizationSource }>();
  for (const candidate of input.profiles ?? []) candidates.set(candidate.profile.profile.id, candidate);
  if (input.profile) candidates.set(input.profile.profile.id, {
    profile: input.profile,
    source: input.profileSource ?? "builtin"
  });
  for (const profileId of input.profile?.profile.allowedChildProfiles ?? []) referenced.add(profileId);
  const queue = [...referenced];
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = candidates.get(queue[index]!);
    if (!candidate) continue;
    for (const childId of candidate.profile.profile.allowedChildProfiles) {
      if (referenced.has(childId)) continue;
      referenced.add(childId);
      queue.push(childId);
    }
  }
  return [...referenced].sort().map((profileId): FrozenSessionProfile => {
    const candidate = candidates.get(profileId);
    if (!candidate) throw new Error(`Agent-profile hook references unknown Agent Profile '${profileId}'.`);
    return {
      id: profileId,
      source: candidate.source,
      digest: candidate.profile.digest,
      canonicalJson: candidate.profile.canonicalJson
    };
  });
}

/** Resolves every session-visible skill body and hook definition before the
 * session starts. The resulting canonical artifact is the only customization
 * source a resumed session needs. */
export async function freezeSessionCustomization(
  input: FreezeCustomizationInput
): Promise<FrozenSessionCustomization> {
  const allowedSkills = input.profile ? new Set(input.profile.profile.skills) : null;
  const skills: FrozenSessionSkill[] = [];
  for (const descriptor of input.skills?.descriptors ?? []) {
    if (allowedSkills && !allowedSkills.has(descriptor.qualifiedName)) continue;
    const loaded = await input.skills?.load(descriptor.qualifiedName);
    if (!loaded) continue;
    skills.push({
      name: descriptor.name,
      qualifiedName: descriptor.qualifiedName,
      description: descriptor.description,
      source: descriptor.source,
      digest: descriptor.digest,
      instructions: loaded.instructions
    });
  }

  const allowedHooks = input.profile ? new Set(input.profile.profile.hooks) : null;
  const suppliedArtifacts = new Map((input.hookArtifacts ?? []).map((item) => [item.definition.id, item]));
  const hooks = (input.hooks ?? [])
    .filter((definition) => !allowedHooks || allowedHooks.has(definition.id))
    .map((definition): FrozenSessionHook => {
      const artifact = suppliedArtifacts.get(definition.id);
      const definitionJson = canonicalize(definition);
      if (artifact && canonicalize(artifact.definition) !== definitionJson) {
        throw new Error(`Hook provenance for '${definition.id}' does not match its resolved definition.`);
      }
      if (artifact && !DIGEST.test(artifact.digest)) {
        throw new Error(`Hook provenance for '${definition.id}' has an invalid digest.`);
      }
      return {
        id: definition.id,
        source: artifact?.source ?? "builtin",
        digest: artifact?.digest ?? sha256(definitionJson),
        definition: structuredClone(definition),
        ...(artifact?.trust ? { trust: structuredClone(artifact.trust) } : {})
      };
    });
  const stored: StoredCustomization = {
    schemaVersion: 3,
    skills: skills.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName)),
    hooks: hooks.sort((left, right) => left.id.localeCompare(right.id)),
    profiles: freezeReferencedProfiles(input, hooks)
  };
  validateHookDefinitions(stored.hooks.map((item) => item.definition));
  if (Buffer.byteLength(canonicalize(stored), "utf8") > MAX_FROZEN_CUSTOMIZATION_BYTES) {
    throw new Error("Frozen session customization exceeds 64 MiB.");
  }
  return materialize(stored);
}

/** Strictly restores and digest-checks a session customization CAS artifact. */
export function restoreSessionCustomization(
  canonicalJson: string,
  expectedDigest: string
): FrozenSessionCustomization {
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_FROZEN_CUSTOMIZATION_BYTES) {
    throw new Error("Frozen session customization exceeds 64 MiB.");
  }
  if (!DIGEST.test(expectedDigest) || sha256(canonicalJson) !== expectedDigest) {
    throw new Error("Frozen session customization artifact digest does not match its event.");
  }
  let value: unknown;
  try { value = JSON.parse(canonicalJson); } catch (error) {
    throw new Error(`Frozen session customization is not valid JSON: ${messageOf(error)}`, { cause: error });
  }
  const stored = storedCustomization(value);
  if (canonicalize(stored) !== canonicalJson) {
    throw new Error("Frozen session customization artifact is not in canonical form.");
  }
  return materialize(stored);
}

function materialize(stored: StoredCustomization): FrozenSessionCustomization {
  const canonicalJson = canonicalize(stored);
  return Object.freeze({
    schemaVersion: stored.schemaVersion,
    skills: Object.freeze(stored.skills.map((item) => Object.freeze(structuredClone(item)))),
    hooks: Object.freeze(stored.hooks.map((item) => Object.freeze({
      ...structuredClone(item), definition: Object.freeze(structuredClone(item.definition))
    }))),
    profiles: Object.freeze((stored.schemaVersion === 2 || stored.schemaVersion === 3 ? stored.profiles : []).map((item) =>
      Object.freeze(structuredClone(item)))),
    canonicalJson,
    digest: sha256(canonicalJson)
  });
}

function storedCustomization(value: unknown): StoredCustomization {
  const root = object(value, "customization");
  const schemaVersion = customizationSchema(root.schemaVersion);
  if (!Array.isArray(root.skills) || !Array.isArray(root.hooks)) {
    throw new Error("Frozen session customization has an invalid schema.");
  }
  exactKeys(root, new Set(hasProfiles(schemaVersion)
    ? ["schemaVersion", "skills", "hooks", "profiles"]
    : ["schemaVersion", "skills", "hooks"]), "customization");
  if (hasProfiles(schemaVersion) && !Array.isArray(root.profiles)) {
    throw new Error("Frozen session customization has invalid profiles.");
  }
  const skills = root.skills.map(skillValue);
  const hooks = root.hooks.map((item) => hookValue(item, schemaVersion));
  const profiles = hasProfiles(schemaVersion)
    ? (root.profiles as unknown[]).map(profileValue) : [];
  unique(skills.map((item) => item.qualifiedName), "skill");
  unique(hooks.map((item) => item.id), "hook");
  unique(profiles.map((item) => item.id), "profile");
  if (!ordered(skills.map((item) => item.qualifiedName)) || !ordered(hooks.map((item) => item.id))
    || !ordered(profiles.map((item) => item.id))) {
    throw new Error("Frozen session customization entries are not canonical ordered.");
  }
  validateHookDefinitions(hooks.map((item) => item.definition));
  if (schemaVersion === 3) return { schemaVersion: 3, skills, hooks, profiles };
  return schemaVersion === 2 ? { schemaVersion: 2, skills, hooks, profiles }
    : { schemaVersion: 1, skills, hooks };
}

function customizationSchema(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new Error("Frozen session customization has an invalid schema.");
  }
  return value;
}
function hasProfiles(schemaVersion: 1 | 2 | 3): schemaVersion is 2 | 3 {
  return schemaVersion !== 1;
}
function profileValue(value: unknown): FrozenSessionProfile {
  const item = object(value, "profile");
  exactKeys(item, new Set(["id", "source", "digest", "canonicalJson"]), "profile");
  const profileId = id(item.id, "profile.id");
  const source = item.source;
  if (source !== "home" && source !== "workspace" && source !== "builtin") {
    throw new Error("Frozen session profile source is invalid.");
  }
  const canonicalJson = string(item.canonicalJson, "profile.canonicalJson");
  const profileDigest = digest(item.digest, "profile.digest");
  const restored = restoreFrozenAgentProfile(canonicalJson, profileDigest);
  if (restored.profile.id !== profileId) throw new Error("Frozen session profile id does not match its content.");
  return { id: profileId, source, digest: profileDigest, canonicalJson };
}

function skillValue(value: unknown): FrozenSessionSkill {
  const item = object(value, "skill");
  exactKeys(item, new Set(["name", "qualifiedName", "description", "source", "digest", "instructions"]), "skill");
  const qualifiedName = text(item.qualifiedName, "skill.qualifiedName");
  const source = item.source;
  if (!QUALIFIED_SKILL.test(qualifiedName) || (source !== "home" && source !== "workspace")
    || !qualifiedName.startsWith(`${source}:`)) throw new Error("Frozen session skill identity is invalid.");
  return {
    name: id(item.name, "skill.name"),
    qualifiedName: qualifiedName as FrozenSessionSkill["qualifiedName"],
    description: text(item.description, "skill.description"),
    source,
    digest: digest(item.digest, "skill.digest"),
    instructions: string(item.instructions, "skill.instructions")
  };
}

function hookValue(value: unknown, schemaVersion: 1 | 2 | 3): FrozenSessionHook {
  const item = object(value, "hook");
  exactKeys(item, new Set(["id", "source", "digest", "definition", "trust"]), "hook");
  const hookId = id(item.id, "hook.id");
  const source = item.source;
  if (source !== "home" && source !== "workspace" && source !== "builtin") {
    throw new Error("Frozen session hook source is invalid.");
  }
  const definition = hookDefinition(item.definition);
  if (definition.id !== hookId) throw new Error("Frozen session hook id does not match its definition.");
  const trust = item.trust === undefined ? undefined : frozenWorkspaceHookTrustValue(item.trust);
  if (schemaVersion === 3 && source === "workspace" && definition.kind === "command" && !trust) {
    throw new Error(`Frozen workspace command hook '${hookId}' requires durable trust.`);
  }
  return { id: hookId, source, digest: digest(item.digest, "hook.digest"), definition, ...(trust ? { trust } : {}) };
}

function hookDefinition(value: unknown): HookDefinition {
  const item = object(value, "hook.definition");
  const common = {
    id: id(item.id, "hook.definition.id"),
    event: oneOf(item.event, [
      "session_start", "run_start", "pre_model", "post_model", "pre_tool",
      "post_tool", "plan_changed", "pre_complete", "run_end"
    ] as const, "hook.definition.event"),
    required: bool(item.required, "hook.definition.required"),
    timeoutMs: integer(item.timeoutMs, "hook.definition.timeoutMs")
  };
  if (item.kind === "command") {
    exactKeys(item, new Set(["id", "event", "required", "timeoutMs", "kind", "command", "args", "cwd", "trustPaths"]), "hook.definition");
    return {
      ...common,
      kind: "command",
      command: text(item.command, "hook.definition.command"),
      args: strings(item.args, "hook.definition.args"),
      ...(item.cwd === undefined ? {} : { cwd: text(item.cwd, "hook.definition.cwd") }),
      ...(item.trustPaths === undefined ? {} : { trustPaths: strings(item.trustPaths, "hook.definition.trustPaths") })
    };
  }
  exactKeys(item, new Set(["id", "event", "required", "timeoutMs", "kind", "profileId", "prompt"]), "hook.definition");
  if (item.kind !== "agent_profile") throw new Error("Frozen session hook kind is invalid.");
  return {
    ...common,
    kind: "agent_profile",
    profileId: id(item.profileId, "hook.definition.profileId"),
    prompt: text(item.prompt, "hook.definition.prompt")
  };
}

function canonicalize(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, visit(child)]));
  };
  return JSON.stringify(visit(value));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Frozen session ${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Frozen session ${label} has unknown key '${unknown}'.`);
  const missing = [...keys].find((key) => !(key in value) && key !== "cwd" && key !== "trustPaths" && key !== "trust");
  if (missing) throw new Error(`Frozen session ${label} has missing key '${missing}'.`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Frozen session ${label} must be non-empty text.`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Frozen session ${label} must be text.`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(result)) throw new Error(`Frozen session ${label} is invalid.`);
  return result;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`Frozen session ${label} is invalid.`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Frozen session ${label} must be boolean.`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Frozen session ${label} must be a positive integer.`);
  return Number(value);
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Frozen session ${label} must be a string array.`);
  }
  return [...value] as string[];
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`Frozen session ${label} is invalid.`);
  return value as T;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Frozen session customization contains duplicate ${label} ids.`);
}
function ordered(values: string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as string).localeCompare(value) <= 0);
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
