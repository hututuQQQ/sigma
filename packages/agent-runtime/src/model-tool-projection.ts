import type { JsonValue, ToolDescriptor } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export interface ModelToolProjectionCapabilities {
  skillsAvailable: boolean;
  environmentMutationAvailable?: boolean;
  processControlsAvailable?: boolean;
  processHandoffAvailable?: boolean;
  childControlsAvailable?: boolean;
  planReadRequired?: boolean;
  artifactReadAvailable?: boolean;
  workspaceFrontierReadRequired?: boolean;
  checkpointListAvailable?: boolean;
  checkpointRestoreAvailable?: boolean;
  restorationConfirmationAvailable?: boolean;
  reviewAvailable?: boolean;
  gitReadAvailable?: boolean;
  repositoryInspectionAvailable?: boolean;
}

function receiptArtifactAvailable(
  receipt: RuntimeSession["durable"]["state"]["receipts"][number]
): boolean {
  return receipt.artifacts.length > 0 || (receipt.artifactRefs?.length ?? 0) > 0;
}

function lifecycleArtifactAvailable(session: RuntimeSession): boolean {
  const state = session.durable.state;
  return [...state.evidence, ...state.mutationEvidence].some((item) => {
    if (item.kind !== "diagnostic") return false;
    const diagnostic = item.data.diagnostic;
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
      return false;
    }
    const artifactIds = (diagnostic as Record<string, unknown>).outputArtifactIds;
    return Array.isArray(artifactIds)
      && artifactIds.some((artifactId) => typeof artifactId === "string" && artifactId.length > 0);
  });
}

/** Frozen sessions never acquire capabilities from changed live state. */
export function sessionSkillProjectionCapabilities(input: {
  frozenCustomization: { readonly skills: readonly { qualifiedName: string }[] };
  profileSkillNames?: readonly string[];
}): ModelToolProjectionCapabilities {
  const allowed = input.profileSkillNames ? new Set(input.profileSkillNames) : undefined;
  const candidates = input.frozenCustomization.skills.map((skill) => skill.qualifiedName);
  const available = new Set(candidates.filter((name) => !allowed || allowed.has(name)));
  return { skillsAvailable: available.size > 0 };
}

function frozenSessionCapabilities(session: RuntimeSession): ModelToolProjectionCapabilities {
  const skillCapabilities = session.durable.frozenCustomization
    ? sessionSkillProjectionCapabilities({
        frozenCustomization: session.durable.frozenCustomization,
        profileSkillNames: session.services.profile?.profile.skills
      })
    : { skillsAvailable: false };
  return {
    ...skillCapabilities,
    environmentMutationAvailable: session.durable.mode === "change"
  };
}

/**
 * Model-facing capabilities are intentionally limited to frozen session
 * boundaries. Live process, plan, artifact, checkpoint, review, and repository
 * state belongs in the append-only runtime suffix; using it to add or remove
 * descriptors invalidates the provider's prompt cache mid-session.
 */
export function stableSessionModelToolProjectionCapabilities(
  session: RuntimeSession
): ModelToolProjectionCapabilities {
  return frozenSessionCapabilities(session);
}

/**
 * Derive live capability telemetry for runtime guidance and diagnostics.
 * Descriptor presentation and admission deliberately use the stable session
 * projection above so these state transitions cannot rewrite model schemas.
 */
export function sessionModelToolProjectionCapabilities(
  session: RuntimeSession
): ModelToolProjectionCapabilities {
  const frozenCapabilities = frozenSessionCapabilities(session);
  const state = session.durable.state;
  const childControlsAvailable = state.childIds.length > 0
    || state.plan.nodes.some((node) => node.owner.kind === "child")
    || state.budget.reservations.some((reservation) =>
      reservation.ownerId.startsWith("child:"))
    || state.evidence.some((item) => item.kind === "child_outcome");
  const frontier = state.mutationFrontier;
  const workspaceChanges = frontier.changedPaths.length;
  const environmentChanges = frontier.environmentChangedPaths?.length ?? 0;
  const checkpointHead = state.checkpointHead;
  const artifactReadAvailable = state.receipts.some(receiptArtifactAvailable)
    || state.reviewReceipts.some((item) => receiptArtifactAvailable(item.receipt))
    || lifecycleArtifactAvailable(session);
  return {
    ...frozenCapabilities,
    processControlsAvailable: state.activeProcessIds.length > 0,
    processHandoffAvailable: [...session.execution.processHandles.values()]
      .some((handle) => handle.lifecycle === "deliverable"),
    childControlsAvailable,
    planReadRequired: state.plan.nodes.length > 32,
    artifactReadAvailable,
    workspaceFrontierReadRequired: workspaceChanges > 32 || environmentChanges > 32,
    checkpointListAvailable: checkpointHead !== undefined,
    checkpointRestoreAvailable: frontier.sourceCheckpointIds.length > 0,
    restorationConfirmationAvailable: checkpointHead?.status === "restored"
      && frontier.sourceCheckpointIds.length === 0,
    reviewAvailable: workspaceChanges + environmentChanges > 0
  };
}

const PROCESS_CONTROL_TOOLS = new Set([
  "process_poll", "process_write", "process_terminate", "process_handoff"
]);
const CHILD_CONTROL_TOOLS = new Set([
  "message_agent", "join_agent", "list_agents", "integrate_agent"
]);
const GIT_READ_TOOLS = new Set(["git_status", "git_diff"]);
const REPOSITORY_INSPECTION_TOOLS = new Set([
  "repository_inspect", "git_transaction"
]);
type DeferredToolCapability =
  | "artifactReadAvailable"
  | "workspaceFrontierReadRequired"
  | "checkpointListAvailable"
  | "checkpointRestoreAvailable"
  | "restorationConfirmationAvailable"
  | "reviewAvailable";
const DEFERRED_TOOL_CAPABILITIES: Readonly<Record<string, DeferredToolCapability>> = {
  read_artifact: "artifactReadAvailable",
  read_workspace_frontier: "workspaceFrontierReadRequired",
  list_checkpoints: "checkpointListAvailable",
  restore_run_changes: "checkpointRestoreAvailable",
  confirm_run_restored: "restorationConfirmationAvailable",
  request_review: "reviewAvailable"
};
const WORKSPACE_WRITE_GUIDANCE =
  " Workspace commands are read-only by default; to create, modify, or delete workspace paths, provide expectedChanges with exact files or narrow directories.";

function deferredDescriptorVisible(
  name: string,
  capabilities: ModelToolProjectionCapabilities
): boolean {
  const capability = DEFERRED_TOOL_CAPABILITIES[name];
  return !capability || capabilities[capability] !== false;
}

function projectedDescriptorVisible(
  descriptor: ToolDescriptor,
  capabilities: ModelToolProjectionCapabilities
): boolean {
  if (!capabilities.skillsAvailable && descriptor.name === "load_skill") return false;
  if (PROCESS_CONTROL_TOOLS.has(descriptor.name)
    && capabilities.processControlsAvailable === false) return false;
  if (descriptor.name === "process_handoff"
    && capabilities.processHandoffAvailable === false) return false;
  if (CHILD_CONTROL_TOOLS.has(descriptor.name)
    && capabilities.childControlsAvailable === false) return false;
  if (GIT_READ_TOOLS.has(descriptor.name)
    && capabilities.gitReadAvailable === false) return false;
  if (REPOSITORY_INSPECTION_TOOLS.has(descriptor.name)
    && capabilities.repositoryInspectionAvailable === false) return false;
  if (!deferredDescriptorVisible(descriptor.name, capabilities)) return false;
  return descriptor.name !== "read_plan" || capabilities.planReadRequired !== false;
}

interface DescriptorPresentation {
  skillFieldsUnavailable: boolean;
  environmentUnavailable: boolean;
  unifiedShell: boolean;
  lowLevelWriteFieldsUnavailable: boolean;
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
  if (presentation.lowLevelWriteFieldsUnavailable) {
    delete properties.access;
    delete properties.writeRoots;
  }
  if (presentation.unifiedShell) {
    if (capabilities.environmentMutationAvailable === false) {
      delete properties.expectedChanges;
    }
  }
  const required = Array.isArray(descriptor.inputSchema.required)
    ? descriptor.inputSchema.required.filter((item) =>
      item !== "skill" && item !== "skillScript"
      && item !== "access" && item !== "writeRoots")
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
    unifiedShell: descriptor.name === "shell",
    lowLevelWriteFieldsUnavailable:
      ["exec", "shell", "validate", "process_spawn"].includes(descriptor.name)
  };
  if (!presentation.skillFieldsUnavailable
    && !presentation.environmentUnavailable
    && !presentation.unifiedShell
    && !presentation.lowLevelWriteFieldsUnavailable) return descriptor;
  const inputSchema = projectedInputSchema(descriptor, presentation, capabilities);
  if (!inputSchema) return descriptor;
  return {
    ...descriptor,
    description: projectedDescription(descriptor, capabilities),
    inputSchema
  };
}

/** Present only session-real capabilities to the model. */
export function projectModelToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  capabilities: ModelToolProjectionCapabilities
): ToolDescriptor[] {
  const visible = descriptors.filter((descriptor) =>
    projectedDescriptorVisible(descriptor, capabilities));
  return visible.map((descriptor) =>
    projectDescriptorPresentation(descriptor, capabilities));
}
