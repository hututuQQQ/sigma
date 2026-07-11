import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillDescriptor, SkillSource } from "./skills.js";

export interface SkillExecutionResource {
  relativePath: string;
  artifactId: string;
  digest: string;
  sizeBytes: number;
  mode: number;
}

export interface SkillExecutionManifest {
  schemaVersion: 1;
  qualifiedName: `${SkillSource}:${string}`;
  source: SkillSource;
  skillDigest: string;
  resources: readonly SkillExecutionResource[];
  canonicalJson: string;
  digest: string;
}

export interface ResolvedSkillExecutionResource extends SkillExecutionResource {
  qualifiedName: `${SkillSource}:${string}`;
  rootPath: string;
  absolutePath: string;
}

export interface CapturedSkillExecutionResource {
  resource: SkillExecutionResource;
  content: Uint8Array;
}

export interface CapturedSkillExecutionSnapshot {
  manifest: SkillExecutionManifest;
  files: readonly CapturedSkillExecutionResource[];
}

const MAX_RESOURCE_BYTES = 16 * 1_048_576;
const MAX_TOTAL_BYTES = 64 * 1_048_576;
const MAX_RESOURCES = 4_096;
const DIGEST = /^[a-f0-9]{64}$/u;

export async function captureSkillExecutionSnapshot(
  descriptor: SkillDescriptor
): Promise<CapturedSkillExecutionSnapshot> {
  const currentSkill = (await readIdentityBoundFile(descriptor.rootPath, "SKILL.md")).content.toString("utf8");
  if (sha256(currentSkill) !== descriptor.digest) throw changed("SKILL.md");
  const files = await executionResources(descriptor.rootPath);
  if (files.find((file) => file.resource.relativePath.toLowerCase() === "skill.md")?.resource.digest
    !== descriptor.digest) throw changed("SKILL.md");
  const manifest = materializeManifest({
    schemaVersion: 1,
    qualifiedName: descriptor.qualifiedName,
    source: descriptor.source,
    skillDigest: descriptor.digest,
    resources: files.map((file) => file.resource)
  });
  return Object.freeze({ manifest, files: Object.freeze(files) });
}

export async function resolveSkillExecutionResource(
  descriptor: SkillDescriptor,
  relativePath: string
): Promise<ResolvedSkillExecutionResource> {
  const normalized = normalizedPath(relativePath);
  if (normalized.toLowerCase() === "skill.md") return denied("SKILL.md is instructions, not an executable skill resource.");
  const absolutePath = await containedFile(descriptor.rootPath, normalized);
  const info = await stat(absolutePath);
  if (info.size > MAX_RESOURCE_BYTES) return tooLarge(relativePath);
  const content = await readFile(absolutePath);
  const digest = sha256(content);
  return {
    qualifiedName: descriptor.qualifiedName,
    rootPath: descriptor.rootPath,
    absolutePath,
    relativePath: normalized,
    artifactId: digest,
    digest,
    sizeBytes: info.size,
    mode: info.mode & 0o777
  };
}

export function restoreSkillExecutionManifest(
  canonicalJson: string,
  expectedDigest: string
): SkillExecutionManifest {
  if (!DIGEST.test(expectedDigest) || sha256(canonicalJson) !== expectedDigest) {
    return invalid("Frozen skill execution manifest digest does not match its artifact.");
  }
  let value: unknown;
  try { value = JSON.parse(canonicalJson); } catch (error) {
    throw Object.assign(new Error("Frozen skill execution manifest is not valid JSON.", { cause: error }), {
      code: "skill_manifest_invalid"
    });
  }
  const restored = materializeManifest(manifestValue(value));
  if (restored.canonicalJson !== canonicalJson) return invalid("Frozen skill execution manifest is not canonical.");
  return restored;
}

async function executionResources(rootPath: string): Promise<CapturedSkillExecutionResource[]> {
  const resources: CapturedSkillExecutionResource[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) return linked(absolutePath);
      if (info.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) return special(absolutePath);
      if (info.size > MAX_RESOURCE_BYTES) return tooLarge(absolutePath);
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
      const captured = await readIdentityBoundFile(rootPath, relativePath);
      totalBytes += captured.content.byteLength;
      if (resources.length >= MAX_RESOURCES || totalBytes > MAX_TOTAL_BYTES) {
        throw Object.assign(new Error("Skill execution resources exceed the 4096-file or 64 MiB freeze limit."), {
          code: "skill_manifest_too_large"
        });
      }
      resources.push({
        resource: {
          relativePath,
          artifactId: captured.digest,
          digest: captured.digest,
          sizeBytes: captured.content.byteLength,
          mode: captured.mode
        },
        content: captured.content
      });
    }
  };
  await visit(rootPath);
  return resources.sort((left, right) => left.resource.relativePath.localeCompare(right.resource.relativePath));
}

async function readIdentityBoundFile(
  rootPath: string,
  relativePath: string
): Promise<{ content: Buffer; digest: string; mode: number }> {
  const root = await realpath(rootPath);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!contained(root, candidate)) throw changed(relativePath);
  const beforePath = await lstat(candidate);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw changed(relativePath);
  const canonicalBefore = await realpath(candidate);
  if (!contained(root, canonicalBefore)) throw changed(relativePath);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(candidate, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(candidate);
    const canonicalAfter = await realpath(candidate);
    if (!validCapturedFile({
      before, after, afterPath, canonicalBefore, canonicalAfter, root, content
    })) throw changed(relativePath);
    return { content, digest: sha256(content), mode: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function containedFile(rootPath: string, relativePath: string): Promise<string> {
  const root = await realpath(rootPath);
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(cursor); } catch (error) {
      throw Object.assign(new Error(`Skill resource '${relativePath}' does not exist.`, { cause: error }), {
        code: "skill_resource_missing"
      });
    }
    if (info.isSymbolicLink()) return linked(relativePath);
  }
  const candidate = await realpath(cursor);
  if (!contained(root, candidate)) return escape();
  if (!(await stat(candidate)).isFile()) return denied(`Skill resource '${relativePath}' is not a file.`);
  return candidate;
}

function normalizedPath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)) return escape();
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return escape();
  return normalized;
}

type StoredManifest = Omit<SkillExecutionManifest, "canonicalJson" | "digest">;

function materializeManifest(stored: StoredManifest): SkillExecutionManifest {
  const canonicalJson = JSON.stringify(stored);
  return Object.freeze({
    ...stored,
    resources: Object.freeze(stored.resources.map((resource) => Object.freeze({ ...resource }))),
    canonicalJson,
    digest: sha256(canonicalJson)
  });
}

function manifestValue(value: unknown): StoredManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const root = value as Record<string, unknown>;
  if (!validManifestHeader(root)) return invalid();
  const resources = (root.resources as unknown[]).map(resourceValue);
  if (new Set(resources.map((item) => item.relativePath)).size !== resources.length
    || resources.some((item, index) => index > 0
      && resources[index - 1]!.relativePath.localeCompare(item.relativePath) >= 0)
    || resources.reduce((sum, item) => sum + item.sizeBytes, 0) > MAX_TOTAL_BYTES) return invalid();
  return {
    schemaVersion: 1,
    qualifiedName: root.qualifiedName as `${SkillSource}:${string}`,
    source: root.source as SkillSource,
    skillDigest: root.skillDigest as string,
    resources
  };
}

function resourceValue(value: unknown): SkillExecutionResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (!validResourceValue(item)) return invalid();
  return {
    relativePath: item.relativePath as string,
    artifactId: item.artifactId as string,
    digest: item.digest as string,
    sizeBytes: Number(item.sizeBytes),
    mode: Number(item.mode)
  };
}

function validManifestHeader(root: Record<string, unknown>): boolean {
  const sourceValid = root.source === "home" || root.source === "workspace";
  return [
    Object.keys(root).sort().join(",") === "qualifiedName,resources,schemaVersion,skillDigest,source",
    root.schemaVersion === 1,
    sourceValid,
    typeof root.qualifiedName === "string",
    typeof root.qualifiedName === "string" && root.qualifiedName.startsWith(`${String(root.source)}:`),
    typeof root.skillDigest === "string",
    typeof root.skillDigest === "string" && DIGEST.test(root.skillDigest),
    Array.isArray(root.resources),
    Array.isArray(root.resources) && root.resources.length <= MAX_RESOURCES
  ].every(Boolean);
}

function validResourceValue(item: Record<string, unknown>): boolean {
  const relativeValid = typeof item.relativePath === "string"
    && normalizedPath(item.relativePath) === item.relativePath;
  return [
    Object.keys(item).sort().join(",") === "artifactId,digest,mode,relativePath,sizeBytes",
    relativeValid,
    typeof item.artifactId === "string",
    typeof item.artifactId === "string" && DIGEST.test(item.artifactId),
    typeof item.digest === "string",
    typeof item.digest === "string" && DIGEST.test(item.digest),
    item.artifactId === item.digest,
    Number.isSafeInteger(item.sizeBytes),
    Number(item.sizeBytes) >= 0,
    Number(item.sizeBytes) <= MAX_RESOURCE_BYTES,
    Number.isSafeInteger(item.mode),
    Number(item.mode) >= 0,
    Number(item.mode) <= 0o777
  ].every(Boolean);
}

function validCapturedFile(input: {
  before: Stats;
  after: Stats;
  afterPath: Stats;
  canonicalBefore: string;
  canonicalAfter: string;
  root: string;
  content: Buffer;
}): boolean {
  return [
    input.before.isFile(),
    input.after.isFile(),
    input.afterPath.isFile(),
    !input.afterPath.isSymbolicLink(),
    sameFile(input.before, input.after),
    sameFile(input.after, input.afterPath),
    samePath(input.canonicalBefore, input.canonicalAfter),
    contained(input.root, input.canonicalAfter),
    input.before.size === input.after.size,
    input.after.size === input.afterPath.size,
    input.content.byteLength === input.after.size,
    input.content.byteLength <= MAX_RESOURCE_BYTES
  ].every(Boolean);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function sameFile(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(message = "Frozen skill execution manifest has an invalid schema."): never {
  throw Object.assign(new Error(message), { code: "skill_manifest_invalid" });
}
function changed(relativePath: string): Error {
  return Object.assign(new Error(`Skill resource '${relativePath}' changed while its frozen bytes were captured.`), { code: "skill_changed" });
}
function denied(message: string): never { throw Object.assign(new Error(message), { code: "skill_resource_denied" }); }
function escape(): never { throw Object.assign(new Error("Skill resource path escapes its skill root."), { code: "skill_resource_escape" }); }
function linked(value: string): never { throw Object.assign(new Error(`Skill execution roots cannot contain links: ${value}`), { code: "skill_resource_link" }); }
function special(value: string): never { throw Object.assign(new Error(`Skill execution roots cannot contain special files: ${value}`), { code: "skill_resource_special" }); }
function tooLarge(value: string): never { throw Object.assign(new Error(`Skill resource '${value}' exceeds 16 MiB.`), { code: "skill_resource_too_large" }); }
