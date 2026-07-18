import type { CheckpointCasStore } from "./cas-store.js";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointOpaqueArtifact,
  type CheckpointRecord,
  type CheckpointReviewMaterial
} from "./types.js";

type OpaqueIdentity = { digest: string; sizeBytes: number };

function metadata(entry: CheckpointEntry | undefined): string {
  return entry ? `${entry.kind}:${entry.mode}` : "absent";
}

function decodeText(content: Buffer): string | null {
  if (content.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
    || content.includes(0x7f)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function identity(entry: CheckpointEntry | undefined): OpaqueIdentity | undefined {
  return entry?.kind === "file" && entry.digest
    ? { digest: entry.digest, sizeBytes: entry.size }
    : undefined;
}

async function renderedContent(
  entry: CheckpointEntry | undefined,
  opaque: OpaqueIdentity | undefined,
  cas: CheckpointCasStore
): Promise<string> {
  if (!entry) return "[absent]";
  if (entry.kind === "directory") return "[directory]";
  if (entry.kind === "symlink") return `[symlink -> ${entry.linkTarget ?? ""}]`;
  if (opaque) return `[binary sha256=${opaque.digest} size=${opaque.sizeBytes}]`;
  if (!entry.casIdentity || !entry.digest) {
    throw new CheckpointConflictError(`Checkpoint manifest lacks a trusted CAS identity: ${entry.path}`);
  }
  const complete = await cas.readPrefix(entry.digest, entry.size, entry.casIdentity);
  if (complete.truncated || complete.content.byteLength !== entry.size) {
    throw new CheckpointConflictError(`Checkpoint CAS object could not be read completely: ${entry.path}`);
  }
  const text = decodeText(complete.content);
  if (text === null) {
    throw new CheckpointConflictError(`Checkpoint text classification changed while reviewing: ${entry.path}`);
  }
  return text;
}

async function renderSection(
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined,
  opaque: CheckpointOpaqueArtifact | undefined,
  cas: CheckpointCasStore
): Promise<string> {
  return `--- ${before ? `a/${file}` : "/dev/null"}\n+++ ${after ? `b/${file}` : "/dev/null"}\n`
    + `[metadata before=${metadata(before)} after=${metadata(after)}]\n`
    + `[before]\n${await renderedContent(before, opaque?.before, cas)}\n`
    + `[after]\n${await renderedContent(after, opaque?.after, cas)}\n`;
}

function renderedContentBytes(entry: CheckpointEntry | undefined, opaque: OpaqueIdentity | undefined): number {
  if (!entry) return Buffer.byteLength("[absent]", "utf8");
  if (entry.kind === "directory") return Buffer.byteLength("[directory]", "utf8");
  if (entry.kind === "symlink") return Buffer.byteLength(`[symlink -> ${entry.linkTarget ?? ""}]`, "utf8");
  if (opaque) return Buffer.byteLength(`[binary sha256=${opaque.digest} size=${opaque.sizeBytes}]`, "utf8");
  return entry.size;
}

function sectionBytes(
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined,
  opaque: CheckpointOpaqueArtifact | undefined
): number {
  const framing = `--- ${before ? `a/${file}` : "/dev/null"}\n+++ ${after ? `b/${file}` : "/dev/null"}\n`
    + `[metadata before=${metadata(before)} after=${metadata(after)}]\n`
    + "[before]\n\n[after]\n\n";
  return Buffer.byteLength(framing, "utf8")
    + renderedContentBytes(before, opaque?.before)
    + renderedContentBytes(after, opaque?.after);
}

function fullyOpaque(
  checkpoint: CheckpointRecord,
  file: string,
  artifact: CheckpointOpaqueArtifact | undefined
): boolean {
  if (!artifact) return false;
  if (checkpoint.delta!.added.includes(file)) return artifact.after !== undefined;
  if (checkpoint.delta!.deleted.includes(file)) return artifact.before !== undefined;
  return artifact.before !== undefined && artifact.after !== undefined;
}

function omittedArtifact(
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined
): CheckpointOpaqueArtifact | undefined {
  const beforeIdentity = identity(before);
  const afterIdentity = identity(after);
  if (!beforeIdentity && !afterIdentity) return undefined;
  return {
    path: file,
    representation: "content_omitted",
    ...(beforeIdentity ? { before: beforeIdentity } : {}),
    ...(afterIdentity ? { after: afterIdentity } : {})
  };
}

function representedBytes(diffParts: readonly string[], artifacts: readonly CheckpointOpaqueArtifact[]): number {
  return Buffer.byteLength(diffParts.join(""), "utf8")
    + Buffer.byteLength(JSON.stringify(artifacts), "utf8");
}

function reviewScopeTooLarge(message: string, action: string): CheckpointReviewMaterial {
  return {
    reviewDiff: "",
    reviewDiffPaths: [],
    opaqueArtifacts: [],
    reviewProblem: { code: "review_scope_too_large", message, action }
  };
}

export async function buildCheckpointReviewMaterial(
  checkpoint: CheckpointRecord,
  before: CheckpointManifest,
  after: CheckpointManifest,
  cas: CheckpointCasStore,
  maxBytes: number,
  opaqueArtifacts: CheckpointOpaqueArtifact[]
): Promise<CheckpointReviewMaterial> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Checkpoint review maxBytes must be a non-negative safe integer.");
  }
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const artifacts: CheckpointOpaqueArtifact[] = opaqueArtifacts.map((artifact) => ({
    ...artifact,
    representation: artifact.representation ?? "binary"
  }));
  const opaqueByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const reviewDiffPaths: string[] = [];
  const diffParts: string[] = [];
  const changed = [...new Set([
    ...checkpoint.delta!.added,
    ...checkpoint.delta!.modified,
    ...checkpoint.delta!.deleted
  ])].sort();

  if (representedBytes(diffParts, artifacts) > maxBytes) {
    return reviewScopeTooLarge(
      "Changed-path identity metadata exceeds the bounded review scope.",
      "Remove generated or temporary artifacts, or split the change into a smaller checkpoint."
    );
  }

  for (const file of changed) {
    const beforeEntry = beforeByPath.get(file);
    const afterEntry = afterByPath.get(file);
    const opaque = opaqueByPath.get(file);
    if (fullyOpaque(checkpoint, file, opaque)) continue;

    const projectedSectionBytes = representedBytes(diffParts, artifacts)
      + sectionBytes(file, beforeEntry, afterEntry, opaque);
    if (projectedSectionBytes <= maxBytes) {
      const section = await renderSection(file, beforeEntry, afterEntry, opaque, cas);
      diffParts.push(section);
      reviewDiffPaths.push(file);
      continue;
    }

    const omitted = omittedArtifact(file, beforeEntry, afterEntry);
    if (!omitted) {
      return reviewScopeTooLarge(
        `Review metadata for '${file}' cannot fit in the bounded review scope.`,
        "Remove generated or temporary artifacts, shorten exceptional paths, or split the change into a smaller checkpoint."
      );
    }
    const existingIndex = artifacts.findIndex((artifact) => artifact.path === file);
    const nextArtifacts = existingIndex < 0
      ? [...artifacts, omitted]
      : artifacts.map((artifact, index) => index === existingIndex ? omitted : artifact);
    if (representedBytes(diffParts, nextArtifacts) > maxBytes) {
      return reviewScopeTooLarge(
        "Changed-path identity metadata exceeds the bounded review scope.",
        "Remove generated or temporary artifacts, or split the change into a smaller checkpoint."
      );
    }
    artifacts.splice(0, artifacts.length, ...nextArtifacts);
    opaqueByPath.set(file, omitted);
  }

  return { reviewDiff: diffParts.join(""), reviewDiffPaths, opaqueArtifacts: artifacts };
}

export async function buildCheckpointReview(
  checkpoint: CheckpointRecord,
  before: CheckpointManifest,
  after: CheckpointManifest,
  cas: CheckpointCasStore,
  maxBytes: number
): Promise<string> {
  return (await buildCheckpointReviewMaterial(checkpoint, before, after, cas, maxBytes, [])).reviewDiff;
}
