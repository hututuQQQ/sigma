import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  captureSkillExecutionSnapshot,
  resolveSkillExecutionResource,
  type CapturedSkillExecutionSnapshot,
  type ResolvedSkillExecutionResource,
  type SkillExecutionManifest
} from "./skill-execution.js";

export type SkillSource = "home" | "workspace";

export interface SkillDiscoveryRoot {
  source: SkillSource;
  directory: string;
}

export interface SkillDescriptor {
  name: string;
  qualifiedName: `${SkillSource}:${string}`;
  description: string;
  source: SkillSource;
  rootPath: string;
  skillFilePath: string;
  digest: string;
}

export interface LoadedSkill {
  qualifiedName: string;
  instructions: string;
  digest: string;
}

export interface SkillResource {
  qualifiedName: string;
  relativePath: string;
  content: string;
  digest: string;
}

const MAX_SKILL_FILE_BYTES = 1_048_576;

export async function discoverSkills(roots: readonly SkillDiscoveryRoot[]): Promise<SkillCatalog> {
  const descriptors: SkillDescriptor[] = [];
  const qualified = new Set<string>();
  for (const root of roots) {
    for (const directory of await skillDirectories(root.directory)) {
      const descriptor = await readDescriptor(root, path.join(root.directory, directory));
      if (qualified.has(descriptor.qualifiedName)) {
        throw new Error(`Duplicate skill '${descriptor.qualifiedName}'.`);
      }
      qualified.add(descriptor.qualifiedName);
      descriptors.push(descriptor);
    }
  }
  return new SkillCatalog(descriptors);
}

export function defaultSkillRoots(homeDirectory: string, workspaceDirectory: string): SkillDiscoveryRoot[] {
  return [
    { source: "home", directory: path.join(homeDirectory, ".sigma", "skills") },
    { source: "workspace", directory: path.join(workspaceDirectory, ".agent", "skills") },
    { source: "workspace", directory: path.join(workspaceDirectory, ".agents", "skills") }
  ];
}

export class SkillCatalog {
  readonly descriptors: readonly SkillDescriptor[];
  private readonly byQualified: ReadonlyMap<string, SkillDescriptor>;

  constructor(descriptors: readonly SkillDescriptor[]) {
    this.descriptors = [...descriptors].sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
    this.byQualified = new Map(this.descriptors.map((descriptor) => [descriptor.qualifiedName, descriptor]));
  }

  resolve(reference: string): SkillDescriptor {
    if (reference.includes(":")) {
      const descriptor = this.byQualified.get(reference);
      if (!descriptor) throw new Error(`Unknown skill '${reference}'.`);
      return descriptor;
    }
    const matches = this.descriptors.filter((descriptor) => descriptor.name === reference);
    if (matches.length === 0) throw new Error(`Unknown skill '${reference}'.`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous skill '${reference}'; use ${matches.map((item) => `'${item.qualifiedName}'`).join(" or ")}.`);
    }
    return matches[0] as SkillDescriptor;
  }

  async load(reference: string): Promise<LoadedSkill> {
    const descriptor = this.resolve(reference);
    const source = await boundedRead(descriptor.skillFilePath);
    assertDigest(descriptor, source);
    return Object.freeze({
      qualifiedName: descriptor.qualifiedName,
      instructions: parseFrontmatter(source, descriptor.skillFilePath).body,
      digest: descriptor.digest
    });
  }

  async readResource(reference: string, relativePath: string): Promise<SkillResource> {
    const descriptor = this.resolve(reference);
    const resourcePath = await containedResourcePath(descriptor.rootPath, relativePath);
    const content = await boundedRead(resourcePath);
    return Object.freeze({
      qualifiedName: descriptor.qualifiedName,
      relativePath: relativePath.replaceAll("\\", "/"),
      content,
      digest: sha256(content)
    });
  }

  /** Captures the complete regular-file tree used by a skill process. Links
   * and special files are rejected so the broker can expose exactly one
   * immutable-by-digest, read-only root. */
  async snapshotExecutionManifest(reference: string): Promise<SkillExecutionManifest> {
    return (await this.captureExecutionSnapshot(reference)).manifest;
  }

  async captureExecutionSnapshot(reference: string): Promise<CapturedSkillExecutionSnapshot> {
    return await captureSkillExecutionSnapshot(this.resolve(reference));
  }

  async resolveExecutionResource(
    reference: string,
    relativePath: string
  ): Promise<ResolvedSkillExecutionResource> {
    return await resolveSkillExecutionResource(this.resolve(reference), relativePath);
  }
}

async function readDescriptor(root: SkillDiscoveryRoot, candidateRoot: string): Promise<SkillDescriptor> {
  const canonicalRoot = await realpath(candidateRoot);
  const skillFilePath = path.join(canonicalRoot, "SKILL.md");
  const source = await boundedRead(skillFilePath);
  const metadata = parseFrontmatter(source, skillFilePath);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(metadata.name)) {
    throw new Error(`Skill '${skillFilePath}' has an invalid name.`);
  }
  return {
    name: metadata.name,
    qualifiedName: `${root.source}:${metadata.name}`,
    description: metadata.description,
    source: root.source,
    rootPath: canonicalRoot,
    skillFilePath,
    digest: sha256(source)
  };
}

async function skillDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseFrontmatter(source: string, filePath: string): { name: string; description: string; body: string } {
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw new Error(`Skill '${filePath}' must start with YAML frontmatter.`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`Skill '${filePath}' has unterminated YAML frontmatter.`);
  const metadata = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([a-z_][a-z0-9_-]*):\s*(.+)$/iu.exec(line);
    if (match) metadata.set(match[1] as string, unquote((match[2] as string).trim()));
  }
  const name = metadata.get("name")?.trim();
  const description = metadata.get("description")?.trim();
  if (!name || !description) throw new Error(`Skill '${filePath}' requires name and description frontmatter.`);
  return { name, description, body: lines.slice(end + 1).join("\n").trimStart() };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function containedResourcePath(root: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Skill resource path must be relative.");
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("Skill resource path escapes its skill root.");
  let candidate: string;
  try { candidate = await realpath(path.join(root, normalized)); } catch (error) {
    throw new Error(`Skill resource '${relativePath}' does not exist.`, { cause: error });
  }
  const canonicalRoot = await realpath(root);
  if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("Skill resource path escapes its skill root.");
  }
  return candidate;
}

async function boundedRead(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Skill resource '${filePath}' is not a file.`);
  if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill resource '${filePath}' exceeds 1 MiB.`);
  return await readFile(filePath, "utf8");
}


function assertDigest(descriptor: SkillDescriptor, source: string): void {
  if (sha256(source) !== descriptor.digest) {
    throw Object.assign(new Error(`Skill '${descriptor.qualifiedName}' changed after discovery.`), { code: "skill_changed" });
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
