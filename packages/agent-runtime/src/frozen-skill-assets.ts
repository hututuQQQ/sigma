import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillExecutionManifest, SkillExecutionResource } from "agent-extensions";
import type { LoadedSkillResourceAccess } from "agent-protocol";
import type { ContentAddressedArtifactStore } from "agent-store";

export function frozenSkillExecutionRoot(storeRootDir: string): string {
  return path.join(path.resolve(storeRootDir), "skill-executions");
}

/** Restores a digest-bound skill tree from session CAS. Planning only derives
 * the stable path; bytes are written after normal tool approval/budget gates. */
export class FrozenSkillMaterializer {
  private readonly storeRoot: string;
  private readonly root: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(storeRootDir: string, private readonly artifacts: ContentAddressedArtifactStore) {
    this.storeRoot = path.resolve(storeRootDir);
    this.root = frozenSkillExecutionRoot(this.storeRoot);
  }

  plannedAccess(
    sessionId: string,
    manifest: SkillExecutionManifest,
    relativePath: string
  ): LoadedSkillResourceAccess {
    if (!/^[a-f0-9]{64}$/u.test(manifest.digest) || sha256(Buffer.from(manifest.canonicalJson, "utf8")) !== manifest.digest) {
      throw Object.assign(new Error("Frozen skill execution manifest identity is invalid."), {
        code: "skill_manifest_invalid"
      });
    }
    const resource = requiredResource(manifest, relativePath);
    const readRoot = this.manifestRoot(sessionId, manifest.digest);
    return {
      qualifiedName: manifest.qualifiedName,
      relativePath: resource.relativePath,
      absolutePath: materializedPath(readRoot, resource.relativePath),
      readRoot,
      digest: resource.digest
    };
  }

  async materialize(
    sessionId: string,
    manifest: SkillExecutionManifest,
    relativePath: string
  ): Promise<LoadedSkillResourceAccess> {
    const access = this.plannedAccess(sessionId, manifest, relativePath);
    const key = access.readRoot;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(async () => await this.ensureTree(sessionId, manifest, access.readRoot));
    this.queues.set(key, current);
    try {
      await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
    return access;
  }

  private manifestRoot(sessionId: string, manifestDigest: string): string {
    const sessionKey = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return path.join(this.root, sessionKey, manifestDigest);
  }

  private async ensureTree(
    sessionId: string,
    manifest: SkillExecutionManifest,
    stableRoot: string
  ): Promise<void> {
    const existing = await lstat(stableRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw stagedChanged(manifest.qualifiedName);
      await verifyTree(stableRoot, manifest);
      return;
    }

    const parent = path.dirname(stableRoot);
    const temporary = path.join(parent, `.tmp-${manifest.digest}-${randomUUID()}`);
    await this.ensureProtectedParent(parent);
    await mkdir(temporary, { mode: 0o700 });
    await assertProtectedDirectory(temporary, parent);
    try {
      for (const resource of manifest.resources) {
        const content = await this.artifacts.get(sessionId, resource.artifactId);
        if (content.byteLength !== resource.sizeBytes || sha256(content) !== resource.digest
          || resource.artifactId !== resource.digest) {
          throw new Error(`Frozen skill CAS asset '${resource.relativePath}' does not match its manifest.`);
        }
        const target = materializedPath(temporary, resource.relativePath);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: "wx", mode: stagedMode(resource) });
        await chmod(target, stagedMode(resource));
      }
      await verifyTree(temporary, manifest);
      await assertProtectedDirectory(parent, this.root);
      try {
        await rename(temporary, stableRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST"
          && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await rm(temporary, { recursive: true, force: true });
        await verifyTree(stableRoot, manifest);
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureProtectedParent(sessionDirectory: string): Promise<void> {
    await assertProtectedDirectory(this.storeRoot, path.dirname(this.storeRoot));
    await createProtectedDirectory(this.root, this.storeRoot);
    await createProtectedDirectory(sessionDirectory, this.root);
  }
}

async function verifyTree(root: string, manifest: SkillExecutionManifest): Promise<void> {
  const actual: string[] = [];
  const actualDirectories: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw stagedChanged(manifest.qualifiedName);
      if (info.isDirectory()) {
        actualDirectories.push(path.relative(root, candidate).split(path.sep).join("/"));
        await visit(candidate);
      } else if (info.isFile()) {
        actual.push(path.relative(root, candidate).split(path.sep).join("/"));
      } else {
        throw stagedChanged(manifest.qualifiedName);
      }
    }
  };
  await visit(root);
  actual.sort((left, right) => left.localeCompare(right));
  const expected = manifest.resources.map((resource) => resource.relativePath);
  const expectedDirectories = [...new Set(manifest.resources.flatMap((resource) => {
    const segments = resource.relativePath.split("/").slice(0, -1);
    return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  }))].sort((left, right) => left.localeCompare(right));
  actualDirectories.sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw stagedChanged(manifest.qualifiedName);
  }
  if (actualDirectories.length !== expectedDirectories.length
    || actualDirectories.some((item, index) => item !== expectedDirectories[index])) {
    throw stagedChanged(manifest.qualifiedName);
  }
  for (const resource of manifest.resources) {
    const target = materializedPath(root, resource.relativePath);
    const info = await lstat(target);
    const content = await readFile(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== resource.sizeBytes
      || sha256(content) !== resource.digest
      || (process.platform !== "win32" && (info.mode & 0o777) !== stagedMode(resource))) {
      throw stagedChanged(manifest.qualifiedName);
    }
  }
}

async function createProtectedDirectory(directory: string, parent: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertProtectedDirectory(directory, parent);
}

async function assertProtectedDirectory(
  directory: string,
  parent: string
): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`Frozen skill execution directory '${directory}' is not a protected directory.`), {
      code: "skill_staging_unsafe"
    });
  }
  const canonicalParent = await realpath(parent);
  const canonicalDirectory = await realpath(directory);
  const relative = path.relative(canonicalParent, canonicalDirectory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`Frozen skill execution directory '${directory}' escapes its protected parent.`), {
      code: "skill_staging_unsafe"
    });
  }
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    const after = await lstat(directory);
    if ((after.mode & 0o077) !== 0) {
      throw Object.assign(new Error(`Frozen skill execution directory '${directory}' has broad permissions.`), {
        code: "skill_staging_unsafe"
      });
    }
  }
}

function requiredResource(manifest: SkillExecutionManifest, relativePath: string): SkillExecutionResource {
  const resource = manifest.resources.find((item) => item.relativePath === relativePath);
  if (!resource || relativePath.toLowerCase() === "skill.md") {
    throw Object.assign(new Error(`Skill resource '${relativePath}' is not executable from the frozen manifest.`), {
      code: "skill_resource_denied"
    });
  }
  return resource;
}

function stagedMode(resource: SkillExecutionResource): number {
  return 0o444 | (resource.mode & 0o111);
}

function materializedPath(root: string, relativePath: string): string {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`Frozen skill asset path '${relativePath}' escapes its root.`), {
      code: "skill_resource_escape"
    });
  }
  return candidate;
}

function stagedChanged(qualifiedName: string): Error {
  return Object.assign(new Error(`Materialized skill tree '${qualifiedName}' no longer matches frozen CAS.`), {
    code: "skill_staging_changed"
  });
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
