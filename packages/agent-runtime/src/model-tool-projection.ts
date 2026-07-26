import type { JsonValue, ToolDescriptor } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export interface ModelToolProjectionCapabilities {
  skillsAvailable: boolean;
  /** Retained for schema-1 recovery compatibility. Loading a skill no longer
   * swaps the foreground tool surface within a session. */
  executableSkillResourcesLoaded: boolean;
  environmentMutationAvailable?: boolean;
  processControlsAvailable?: boolean;
  childControlsAvailable?: boolean;
  planReadRequired?: boolean;
}

/** Frozen sessions never acquire capabilities from changed live state. */
export function sessionSkillProjectionCapabilities(input: {
  frozenCustomization: { readonly skills: readonly { qualifiedName: string }[] };
  loadedSkills: readonly {
    qualifiedName: string;
    executionManifestArtifactId?: string;
    executionManifestDigest?: string;
  }[];
  profileSkillNames?: readonly string[];
}): ModelToolProjectionCapabilities {
  const allowed = input.profileSkillNames ? new Set(input.profileSkillNames) : undefined;
  const candidates = input.frozenCustomization.skills.map((skill) => skill.qualifiedName);
  const available = new Set(candidates.filter((name) => !allowed || allowed.has(name)));
  return {
    skillsAvailable: available.size > 0,
    executableSkillResourcesLoaded: input.loadedSkills.some((skill) =>
      available.has(skill.qualifiedName)
      && Boolean(skill.executionManifestArtifactId && skill.executionManifestDigest)
    )
  };
}

/** Derive one durable capability projection for both model preparation and
 * tool-call admission. Runtime-only handles never widen a restored session. */
export function sessionModelToolProjectionCapabilities(
  session: RuntimeSession
): ModelToolProjectionCapabilities {
  const skillCapabilities = session.durable.frozenCustomization
    ? sessionSkillProjectionCapabilities({
        frozenCustomization: session.durable.frozenCustomization,
        loadedSkills: session.durable.state.frozenSkills,
        profileSkillNames: session.services.profile?.profile.skills
      })
    : { skillsAvailable: false, executableSkillResourcesLoaded: false };
  const state = session.durable.state;
  const childControlsAvailable = state.childIds.length > 0
    || state.plan.nodes.some((node) => node.owner.kind === "child")
    || state.budget.reservations.some((reservation) =>
      reservation.ownerId.startsWith("child:"))
    || state.evidence.some((item) => item.kind === "child_outcome");
  return {
    ...skillCapabilities,
    environmentMutationAvailable: session.durable.mode === "change",
    processControlsAvailable: state.activeProcessIds.length > 0,
    childControlsAvailable,
    planReadRequired: state.plan.nodes.length > 32
  };
}

const PROCESS_CONTROL_TOOLS = new Set([
  "process_poll", "process_write", "process_terminate", "process_handoff"
]);
const CHILD_CONTROL_TOOLS = new Set([
  "message_agent", "join_agent", "list_agents", "integrate_agent"
]);
const WORKSPACE_WRITE_GUIDANCE =
  " Workspace commands are read-only by default; to create, modify, or delete workspace paths, provide expectedChanges with exact files or narrow directories.";

function hiddenByUnifiedShell(
  toolName: string,
  shellAvailable: boolean,
  unifiedShell: Record<string, JsonValue> | undefined
): boolean {
  if (toolName === "exec") return shellAvailable;
  if (toolName === "validate") return Boolean(unifiedShell?.validation);
  return toolName === "process_spawn" && Boolean(unifiedShell?.background);
}

function projectedDescriptorVisible(
  descriptor: ToolDescriptor,
  capabilities: ModelToolProjectionCapabilities,
  shellAvailable: boolean,
  unifiedShell: Record<string, JsonValue> | undefined
): boolean {
  if (!capabilities.skillsAvailable && descriptor.name === "load_skill") return false;
  if (hiddenByUnifiedShell(descriptor.name, shellAvailable, unifiedShell)) return false;
  if (PROCESS_CONTROL_TOOLS.has(descriptor.name)
    && capabilities.processControlsAvailable === false) return false;
  if (CHILD_CONTROL_TOOLS.has(descriptor.name)
    && capabilities.childControlsAvailable === false) return false;
  return descriptor.name !== "read_plan" || capabilities.planReadRequired !== false;
}

interface DescriptorPresentation {
  skillFieldsUnavailable: boolean;
  environmentUnavailable: boolean;
  unifiedShell: boolean;
}

function projectedInputSchema(
  descriptor: ToolDescriptor,
  presentation: DescriptorPresentation,
  capabilities: ModelToolProjectionCapabilities
): ToolDescriptor["inputSchema"] | undefined {
  const rawProperties = descriptor.inputSchema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return undefined;
  }
  const properties = { ...(rawProperties as Record<string, JsonValue>) };
  if (presentation.skillFieldsUnavailable) {
    delete properties.skill;
    delete properties.skillScript;
  }
  if (presentation.environmentUnavailable) delete properties.target;
  if (presentation.unifiedShell) {
    // expectedChanges is sufficient for ordinary workspace writes. Runtime
    // descriptors retain lower-level write and validation-intent fields for
    // durable-call compatibility.
    delete properties.access;
    delete properties.writeRoots;
    delete properties.purpose;
    delete properties.subjects;
    delete properties.criterionIds;
    if (capabilities.environmentMutationAvailable === false) {
      delete properties.expectedChanges;
    }
  }
  const required = Array.isArray(descriptor.inputSchema.required)
    ? descriptor.inputSchema.required.filter((item) =>
      item !== "skill" && item !== "skillScript")
    : undefined;
  return {
    ...descriptor.inputSchema,
    properties,
    ...(required ? { required } : {})
  };
}

function projectedDescription(
  descriptor: ToolDescriptor,
  capabilities: ModelToolProjectionCapabilities
): string {
  let description = descriptor.description;
  if (capabilities.environmentMutationAvailable === false) {
    description = description.replace(WORKSPACE_WRITE_GUIDANCE, "");
    description = description.replace(/ Set target=environment\b.*$/s, "");
  }
  return description
    .replace(
      " With skill and skillScript, the frozen script is prepended to interpreter args.",
      ""
    );
}

function projectDescriptorPresentation(
  descriptor: ToolDescriptor,
  capabilities: ModelToolProjectionCapabilities
): ToolDescriptor {
  const presentation: DescriptorPresentation = {
    skillFieldsUnavailable: !capabilities.skillsAvailable
      && ["exec", "shell", "validate", "process_spawn"].includes(descriptor.name),
    environmentUnavailable: (descriptor.name === "shell"
      || descriptor.name === "process_spawn")
      && capabilities.environmentMutationAvailable === false,
    unifiedShell: descriptor.name === "shell"
  };
  if (!presentation.skillFieldsUnavailable
    && !presentation.environmentUnavailable
    && !presentation.unifiedShell) return descriptor;
  const inputSchema = projectedInputSchema(descriptor, presentation, capabilities);
  if (!inputSchema) return descriptor;
  return {
    ...descriptor,
    description: projectedDescription(descriptor, capabilities),
    inputSchema
  };
}

/** Present only session-real capabilities to the model while leaving the
 * authoritative registry unchanged for durable recovery and stale-call denial. */
export function projectModelToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  capabilities: ModelToolProjectionCapabilities
): ToolDescriptor[] {
  const shellDescriptor = descriptors.find((descriptor) =>
    descriptor.name === "shell");
  const shellProperties = shellDescriptor?.inputSchema.properties;
  const unifiedShell = shellProperties
    && typeof shellProperties === "object"
    && !Array.isArray(shellProperties)
    ? shellProperties as Record<string, JsonValue>
    : undefined;
  const shellAvailable = Boolean(shellDescriptor);
  const visible = descriptors.filter((descriptor) =>
    projectedDescriptorVisible(
      descriptor, capabilities, shellAvailable, unifiedShell
    ));
  return visible.map((descriptor) =>
    projectDescriptorPresentation(descriptor, capabilities));
}
