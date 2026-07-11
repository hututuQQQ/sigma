import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  defaultSkillRoots,
  discoverSkills,
  freezeSessionCustomization,
  restoreSkillExecutionManifest
} from "../packages/agent-extensions/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import { FrozenSkillMaterializer } from "../packages/agent-runtime/src/index.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { ContentAddressedArtifactStore } from "../packages/agent-store/src/index.js";

describe("frozen skill CAS materialization", () => {
  it("plans without writes and executes the frozen tree after the live source is deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-skill-assets-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const storeRoot = path.join(root, "store");
    const skillRoot = path.join(home, ".sigma", "skills", "runner");
    const scriptPath = path.join(skillRoot, "scripts", "run.mjs");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", "name: runner", "description: Run a frozen helper", "---", "Use scripts/run.mjs", ""
    ].join("\n"));
    await writeFile(scriptPath, "console.log('ORIGINAL');\n");
    const catalog = await discoverSkills(defaultSkillRoots(home, workspace));
    const snapshot = await catalog.captureExecutionSnapshot("home:runner");
    const artifacts = new ContentAddressedArtifactStore(storeRoot);
    for (const file of snapshot.files) {
      expect(await artifacts.put("session", file.content)).toBe(file.resource.artifactId);
    }
    const materializer = new FrozenSkillMaterializer(storeRoot, artifacts);
    const planned = materializer.plannedAccess("session", snapshot.manifest, "scripts/run.mjs");
    await expect(stat(planned.readRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(skillRoot, { recursive: true, force: true });
    const access = await materializer.materialize("session", snapshot.manifest, "scripts/run.mjs");
    expect(access).toEqual(planned);
    expect(access.readRoot).not.toContain(skillRoot);
    expect(await readFile(access.absolutePath, "utf8")).toBe("console.log('ORIGINAL');\n");
    if (process.platform !== "win32") {
      expect((await stat(access.absolutePath)).mode & 0o222).toBe(0);
    }

    const extraDirectory = path.join(access.readRoot, "unmanifested-empty-directory");
    await mkdir(extraDirectory);
    await expect(materializer.materialize("session", snapshot.manifest, "scripts/run.mjs"))
      .rejects.toMatchObject({ code: "skill_staging_changed" });
    await rm(extraDirectory, { recursive: true, force: true });

    await chmod(access.absolutePath, 0o644);
    await writeFile(access.absolutePath, "console.log('TAMPERED');\n");
    await expect(materializer.materialize("session", snapshot.manifest, "scripts/run.mjs"))
      .rejects.toMatchObject({ code: "skill_staging_changed" });
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a pre-positioned execution-root link before restoring CAS bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-skill-link-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const storeRoot = path.join(root, "store");
    const skillRoot = path.join(home, ".sigma", "skills", "runner");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", "name: runner", "description: Run a helper", "---", "Use run.mjs", ""
    ].join("\n"));
    await writeFile(path.join(skillRoot, "run.mjs"), "console.log('safe');\n");
    const catalog = await discoverSkills(defaultSkillRoots(home, workspace));
    const snapshot = await catalog.captureExecutionSnapshot("home:runner");
    const artifacts = new ContentAddressedArtifactStore(storeRoot);
    for (const file of snapshot.files) await artifacts.put("session", file.content);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, path.join(storeRoot, "skill-executions"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      await rm(root, { recursive: true, force: true });
      return;
    }
    const materializer = new FrozenSkillMaterializer(storeRoot, artifacts);
    await expect(materializer.materialize("session", snapshot.manifest, "run.mjs"))
      .rejects.toMatchObject({ code: "skill_staging_unsafe" });
    expect(await readdir(outside)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("requires load_skill and resolves only canonical frozen resources without consulting live source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-skill-control-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const storeRoot = path.join(root, "store");
    const skillRoot = path.join(workspace, ".agent", "skills", "runner");
    await mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", "name: runner", "description: Run a frozen helper", "---", "Use scripts/run.mjs", ""
    ].join("\n"));
    await writeFile(path.join(skillRoot, "scripts", "run.mjs"), "console.log('FROZEN');\n");
    const catalog = await discoverSkills(defaultSkillRoots(home, workspace));
    const customization = await freezeSessionCustomization({ skills: catalog });
    const artifacts = new ContentAddressedArtifactStore(storeRoot);
    const state = createKernelState({
      sessionId: "session",
      runId: "run",
      mode: "analyze",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    const session = {
      sessionId: "session",
      runId: "run",
      workspacePath: workspace,
      frozenCustomization: customization,
      state
    } as RuntimeSession;
    const materializer = new FrozenSkillMaterializer(storeRoot, artifacts);
    const control = new RuntimeControlService({
      checkpoints: {} as never,
      budgets: {} as never,
      skills: catalog,
      emit: async (_session, type, _authority, payload) => {
        if (type !== "skill.loaded") return;
        const loaded = payload as {
          artifactId: string;
          digest: string;
          source: "home" | "workspace";
          qualifiedName: string;
          executionManifestArtifactId?: string;
          executionManifestDigest?: string;
        };
        state.frozenSkills.push({ ...loaded });
      },
      createArtifact: async (sessionId, content) => await artifacts.put(sessionId, content),
      readArtifact: async (sessionId, artifactId) => (await artifacts.get(sessionId, artifactId)).toString("utf8"),
      skillMaterializer: materializer
    }).forSession(session);

    await expect(control.resolveLoadedSkillResource({
      qualifiedName: "workspace:runner", relativePath: "scripts/run.mjs", purpose: "plan"
    })).rejects.toMatchObject({ code: "skill_not_loaded" });
    await control.loadSkill("workspace:runner");
    const loaded = state.frozenSkills[0]!;
    const manifestJson = (await artifacts.get("session", loaded.executionManifestArtifactId!)).toString("utf8");
    const manifest = restoreSkillExecutionManifest(manifestJson, loaded.executionManifestDigest!);
    for (const resource of manifest.resources) {
      expect(await artifacts.get("session", resource.artifactId)).toHaveLength(resource.sizeBytes);
    }
    await expect(control.resolveLoadedSkillResource({
      qualifiedName: "workspace:runner", relativePath: "../outside.mjs", purpose: "plan"
    })).rejects.toMatchObject({ code: "skill_resource_escape" });

    await rm(skillRoot, { recursive: true, force: true });
    const planned = await control.resolveLoadedSkillResource({
      qualifiedName: "workspace:runner", relativePath: "scripts/run.mjs", purpose: "plan"
    });
    const executed = await control.resolveLoadedSkillResource({
      qualifiedName: "workspace:runner", relativePath: "scripts/run.mjs", purpose: "execute"
    });
    expect(executed).toEqual(planned);
    expect(await readFile(executed.absolutePath, "utf8")).toBe("console.log('FROZEN');\n");

    loaded.executionManifestDigest = "0".repeat(64);
    await expect(control.resolveLoadedSkillResource({
      qualifiedName: "workspace:runner", relativePath: "scripts/run.mjs", purpose: "plan"
    })).rejects.toMatchObject({ code: "skill_manifest_invalid" });
    await rm(root, { recursive: true, force: true });
  });
});
