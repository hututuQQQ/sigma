import { randomUUID } from "node:crypto";
import {
  freezeSessionCustomization,
  type FrozenAgentProfile,
  type FrozenSessionCustomization,
  type HookDefinition,
  type HookEvent,
  type RuntimeHookArtifact,
  type SkillCatalog
} from "agent-extensions";
import type {
  PlanGraph,
  StartSession
} from "agent-protocol";
import type { RuntimeAgentProfile, RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { persistFrozenWorkspaceHookAssets } from "./frozen-hook-assets.js";

type DispatchHook = (
  session: RuntimeSession,
  event: HookEvent,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal
) => Promise<unknown>;

export interface RuntimeSessionInitializationOptions {
  profile?: FrozenAgentProfile;
  profileSource?: "home" | "workspace" | "builtin";
  availableProfiles?: readonly RuntimeAgentProfile[];
  skills?: SkillCatalog;
  hooks?: readonly HookDefinition[];
  hookArtifacts?: readonly RuntimeHookArtifact[];
  putArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  emit: RuntimeEventEmitter;
  dispatchHook: DispatchHook;
}

function initialPlan(input: StartSession): PlanGraph {
  const title = input.title?.trim();
  return {
    revision: 1,
    goal: title || "Complete the user's stated task.",
    activeNodeId: "root",
    nodes: [{
      id: "root",
      title: title || "Complete the task",
      dependencies: [],
      status: "in_progress",
      owner: { kind: "root" },
      acceptanceCriteria: ["Complete the user's stated task with durable evidence."],
      evidence: []
    }]
  };
}

async function emitResolvedProfile(
  session: RuntimeSession,
  options: RuntimeSessionInitializationOptions
): Promise<void> {
  if (!options.profile) return;
  const artifactId = await options.putArtifact(session.sessionId, options.profile.canonicalJson);
  await options.emit(session, "profile.resolved", "runtime", {
    profileId: options.profile.profile.id,
    digest: options.profile.digest,
    artifactId,
    source: options.profileSource ?? "builtin"
  });
}

export function addFrozenSkillMetadata(
  session: RuntimeSession,
  customization: FrozenSessionCustomization
): void {
  for (const skill of customization.skills) {
    const content = `Available skill ${skill.qualifiedName}: ${skill.description} (digest ${skill.digest}). Call load_skill to load its instructions.`;
    const id = `skill:${skill.qualifiedName}:${skill.digest}`;
    if (session.loadedContextIds.has(id)) continue;
    session.contextItems.push({
      id,
      authority: skill.source === "workspace" ? "project" : "runtime",
      provenance: `${skill.source} skill metadata`,
      content,
      tokenCount: Math.ceil(content.length / 4),
      priority: 800
    });
    session.loadedContextIds.add(id);
  }
}

async function emitFrozenCustomization(
  session: RuntimeSession,
  options: RuntimeSessionInitializationOptions
): Promise<void> {
  const customization = await freezeSessionCustomization({
    profile: options.profile,
    profileSource: options.profileSource,
    profiles: options.availableProfiles,
    skills: options.skills,
    hooks: options.hooks,
    hookArtifacts: options.hookArtifacts
  });
  await persistFrozenWorkspaceHookAssets(
    session.workspacePath,
    session.sessionId,
    customization,
    async (sessionId, content) => await options.putArtifact(sessionId, content)
  );
  const artifactId = await options.putArtifact(session.sessionId, customization.canonicalJson);
  if (artifactId !== customization.digest) {
    throw new Error("Customization artifact store returned a non-content-addressed identifier.");
  }
  session.frozenCustomization = customization;
  await options.emit(session, "customization.frozen", "runtime", {
    digest: customization.digest,
    artifactId,
    skillCount: customization.skills.length,
    hookCount: customization.hooks.length,
    profileCount: customization.profiles.length
  });
  addFrozenSkillMetadata(session, customization);
}

async function emitReviewerWaiver(
  session: RuntimeSession,
  reason: string | undefined,
  emit: RuntimeEventEmitter
): Promise<void> {
  const normalizedReason = reason?.trim();
  if (!normalizedReason) return;
  await emit(session, "review.waived", "user", {
    evidenceId: randomUUID(),
    sessionId: session.sessionId,
    runId: session.runId,
    kind: "user_waiver",
    status: "informational",
    createdAt: new Date().toISOString(),
    producer: { authority: "user", id: "cli" },
    summary: "The user explicitly waived the independent reviewer for this run.",
    data: { scope: "review", reason: normalizedReason }
  });
}

export async function initializeRuntimeSession(
  session: RuntimeSession,
  input: StartSession,
  options: RuntimeSessionInitializationOptions
): Promise<void> {
  await options.emit(session, "session.created", "runtime", {
    workspacePath: session.workspacePath,
    mode: input.mode,
    title: input.title ?? "",
    writeScope: session.writeScope,
    strictWriteScope: session.strictWriteScope,
    modelRole: session.modelRole,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {})
  });
  await emitResolvedProfile(session, options);
  await emitFrozenCustomization(session, options);
  await options.dispatchHook(session, "session_start", {
    sessionId: session.sessionId,
    runId: session.runId,
    workspacePath: session.workspacePath,
    mode: session.mode,
    profileId: options.profile?.profile.id ?? null
  }, new AbortController().signal);
  const plan = initialPlan(input);
  await options.emit(session, "plan.updated", "runtime", { previousRevision: 0, plan });
  await options.dispatchHook(session, "plan_changed", {
    previousRevision: 0,
    plan,
    source: "session"
  }, new AbortController().signal);
  await emitReviewerWaiver(session, input.reviewerWaiverReason, options.emit);
}
