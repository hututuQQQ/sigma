import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  restoreSkillExecutionManifest,
  type SkillCatalog,
  type SkillExecutionManifest
} from "agent-extensions";
import type { EvidenceRecord, LoadedSkillResourceAccess } from "agent-protocol";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

export interface RuntimeSkillControlOptions {
  skills?: SkillCatalog;
  emit: RuntimeEventEmitter;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  readArtifact(sessionId: string, artifactId: string): Promise<string>;
  skillMaterializer?: {
    plannedAccess(sessionId: string, manifest: SkillExecutionManifest, relativePath: string): LoadedSkillResourceAccess;
    materialize(sessionId: string, manifest: SkillExecutionManifest, relativePath: string): Promise<LoadedSkillResourceAccess>;
  };
}

export class RuntimeSkillControl {
  constructor(private readonly options: RuntimeSkillControlOptions) {}

  async loadSkill(session: RuntimeSession, qualifiedName: string): Promise<{ content: string; evidence: EvidenceRecord }> {
    assertSkillAllowed(session, qualifiedName);
    const previouslyLoaded = session.durable.state.frozenSkills.find((item) => item.qualifiedName === qualifiedName);
    const skill = await this.resolveSessionSkill(session, qualifiedName, previouslyLoaded);
    const artifactId = previouslyLoaded?.artifactId
      ?? await this.options.createArtifact(session.identity.sessionId, skill.instructions);
    const manifest = previouslyLoaded ? undefined : await this.freezeManifest(session.identity.sessionId, skill);
    const manifestArtifactId = manifest
      ? await this.options.createArtifact(session.identity.sessionId, manifest.canonicalJson)
      : undefined;
    if (manifest && manifestArtifactId !== manifest.digest) {
      throw new Error("Skill execution manifest store returned a non-content-addressed identifier.");
    }
    if (!previouslyLoaded) {
      await this.options.emit(session, "skill.loaded", "runtime", {
        qualifiedName: skill.qualifiedName,
        digest: skill.digest,
        source: skill.source,
        artifactId,
        ...(manifestArtifactId ? {
          executionManifestArtifactId: manifestArtifactId,
          executionManifestDigest: manifest!.digest
        } : {})
      });
    }
    const evidence = skillEvidence(session, skill, artifactId);
    await this.options.emit(session, "evidence.recorded", "runtime", evidence);
    return { content: skill.instructions, evidence };
  }

  async resolveLoadedSkillResource(
    session: RuntimeSession,
    input: { qualifiedName: string; relativePath: string; purpose: "plan" | "execute" }
  ): Promise<LoadedSkillResourceAccess> {
    const frozen = session.durable.frozenCustomization?.skills.find((item) => item.qualifiedName === input.qualifiedName);
    if (!frozen) return fail(`Skill '${input.qualifiedName}' is not frozen in this session.`, "skill_unknown");
    const loaded = session.durable.state.frozenSkills.find((item) => item.qualifiedName === input.qualifiedName);
    if (!loaded) return fail(
      `Skill '${input.qualifiedName}' must be loaded with load_skill before executing resources.`,
      "skill_not_loaded"
    );
    if (loaded.digest !== frozen.digest || loaded.source !== frozen.source) {
      return fail(`Loaded skill '${input.qualifiedName}' does not match the frozen session skill.`, "skill_manifest_invalid");
    }
    if (!loaded.executionManifestArtifactId || !loaded.executionManifestDigest) {
      return fail(`Skill '${input.qualifiedName}' has no frozen execution-resource manifest.`, "skill_execution_unavailable");
    }
    const artifact = await this.options.readArtifact(session.identity.sessionId, loaded.executionManifestArtifactId);
    const manifest = restoreSkillExecutionManifest(artifact, loaded.executionManifestDigest);
    if (manifest.qualifiedName !== frozen.qualifiedName || manifest.skillDigest !== frozen.digest
      || manifest.source !== frozen.source) {
      return fail(`Skill '${input.qualifiedName}' execution manifest has invalid provenance.`, "skill_manifest_invalid");
    }
    const relativePath = canonicalResourcePath(input.relativePath);
    if (!manifest.resources.some((item) => item.relativePath === relativePath)
      || relativePath.toLowerCase() === "skill.md") {
      return fail(`Skill resource '${input.relativePath}' is not part of the frozen execution manifest.`, "skill_resource_denied");
    }
    if (!this.options.skillMaterializer) return fail(
      "Frozen skill resource materialization is unavailable.",
      "skill_execution_unavailable"
    );
    const planned = this.options.skillMaterializer.plannedAccess(session.identity.sessionId, manifest, relativePath);
    assertExternalRoot(session.identity.workspacePath, planned.readRoot);
    return input.purpose === "execute"
      ? await this.options.skillMaterializer.materialize(session.identity.sessionId, manifest, relativePath)
      : planned;
  }

  private async freezeManifest(sessionId: string, skill: {
    qualifiedName: string;
    digest: string;
    source: "home" | "workspace";
  }): Promise<SkillExecutionManifest | undefined> {
    if (!this.options.skills) return undefined;
    let snapshot: Awaited<ReturnType<SkillCatalog["captureExecutionSnapshot"]>>;
    try { snapshot = await this.options.skills.captureExecutionSnapshot(skill.qualifiedName); } catch { return undefined; }
    if (snapshot.manifest.skillDigest !== skill.digest || snapshot.manifest.source !== skill.source) return undefined;
    for (const file of snapshot.files) {
      const artifactId = await this.options.createArtifact(sessionId, file.content);
      if (artifactId !== file.resource.artifactId || artifactId !== file.resource.digest) {
        throw new Error(`Skill resource '${file.resource.relativePath}' did not retain its frozen CAS identity.`);
      }
    }
    return snapshot.manifest;
  }

  private async resolveSessionSkill(
    session: RuntimeSession,
    qualifiedName: string,
    previouslyLoaded: RuntimeSession["durable"]["state"]["frozenSkills"][number] | undefined
  ): Promise<{ qualifiedName: string; instructions: string; digest: string; source: "home" | "workspace" }> {
    const frozen = session.durable.frozenCustomization?.skills.find((item) => item.qualifiedName === qualifiedName);
    if (frozen) return { ...frozen };
    if (session.durable.frozenCustomization) return fail(`Unknown frozen skill '${qualifiedName}'.`, "skill_unknown");
    if (previouslyLoaded) {
      return {
        qualifiedName,
        instructions: await this.options.readArtifact(session.identity.sessionId, previouslyLoaded.artifactId),
        digest: previouslyLoaded.digest,
        source: previouslyLoaded.source === "home" ? "home" : "workspace"
      };
    }
    if (!this.options.skills) throw new Error("No frozen or current skill catalog is configured for this session.");
    const loaded = await this.options.skills.load(qualifiedName);
    return { ...loaded, source: loaded.qualifiedName.startsWith("home:") ? "home" : "workspace" };
  }
}

function assertSkillAllowed(session: RuntimeSession, qualifiedName: string): void {
  if (!session.services.profile || session.services.profile.profile.skills.includes(qualifiedName)) return;
  fail(`Skill '${qualifiedName}' is not allowed by the frozen Agent Profile.`, "profile_denied");
}

function skillEvidence(
  session: RuntimeSession,
  skill: { qualifiedName: string; digest: string },
  artifactId: string
): EvidenceRecord {
  return {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "diagnostic",
    status: "informational",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: "skill-loader" },
    summary: `Loaded frozen skill '${skill.qualifiedName}'.`,
    data: { source: "skill", diagnostic: { qualifiedName: skill.qualifiedName, digest: skill.digest, artifactId } }
  };
}

function canonicalResourcePath(value: string): string {
  if (!value || value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return fail("Skill resource path must be relative.", "skill_resource_escape");
  }
  const slashPath = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== slashPath) {
    return fail("Skill resource path escapes or is not canonical within its skill root.", "skill_resource_escape");
  }
  return normalized;
}

function assertExternalRoot(workspacePath: string, readRoot: string): void {
  const workspace = path.resolve(workspacePath);
  const root = path.resolve(readRoot);
  if (contained(workspace, root) || contained(root, workspace)) {
    fail("Frozen skill execution storage must be disjoint from the workspace.", "skill_execution_unavailable");
  }
}

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}
