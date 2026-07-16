import type { CheckpointCasStore } from "./cas-store.js";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointOpaqueArtifact,
  type CheckpointRecord,
  type CheckpointReviewMaterial
} from "./types.js";

const TRUNCATION_MARKER = "[review diff truncated]";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

class ReviewBudget {
  private readonly parts: string[] = [];
  private outputRemaining: number;
  private readRemaining: number;
  private readonly maxBytes: number;
  truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    this.outputRemaining = maxBytes;
    this.readRemaining = maxBytes;
  }

  get availableOutput(): number {
    return this.outputRemaining;
  }

  get availableRead(): number {
    return this.readRemaining;
  }

  append(value: string): boolean {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength <= this.outputRemaining) {
      this.parts.push(value);
      this.outputRemaining -= bytes.byteLength;
      return true;
    }
    if (this.outputRemaining > 0) {
      const decoder = new TextDecoder("utf-8");
      this.parts.push(decoder.decode(bytes.subarray(0, this.outputRemaining), { stream: true }));
    }
    this.outputRemaining = 0;
    this.truncated = true;
    return false;
  }

  recordRead(bytes: number): void {
    this.readRemaining -= bytes;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  value(): string {
    const value = this.parts.join("");
    if (!this.truncated) return value;
    const bytes = Buffer.from(value, "utf8");
    const decoder = new TextDecoder("utf-8");
    const prefix = decoder.decode(bytes.subarray(0, this.maxBytes - TRUNCATION_MARKER_BYTES), { stream: true });
    return `${prefix}${TRUNCATION_MARKER}`;
  }
}

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

async function appendContent(
  budget: ReviewBudget,
  entry: CheckpointEntry | undefined,
  opaque: OpaqueIdentity | undefined,
  cas: CheckpointCasStore
): Promise<boolean> {
  if (!entry) return budget.append("[absent]");
  if (entry.kind === "directory") return budget.append("[directory]");
  if (entry.kind === "symlink") return budget.append(`[symlink -> ${entry.linkTarget ?? ""}]`);
  if (opaque) return budget.append(`[binary sha256=${opaque.digest} size=${opaque.sizeBytes}]`);
  const limit = Math.min(budget.availableOutput, budget.availableRead);
  if (limit <= 0) {
    budget.markTruncated();
    return false;
  }
  if (!entry.casIdentity) {
    throw new CheckpointConflictError(`Checkpoint manifest lacks a trusted CAS identity: ${entry.path}`);
  }
  const prefix = await cas.readPrefix(entry.digest!, limit, entry.casIdentity);
  budget.recordRead(prefix.content.byteLength);
  const text = decodeText(prefix.content);
  const appended = budget.append(text === null
    ? `[binary sha256=${entry.digest} size=${entry.size}]`
    : text);
  if (prefix.truncated) {
    budget.markTruncated();
    budget.append("\n[content truncated]");
    return false;
  }
  return appended;
}

async function appendSection(
  budget: ReviewBudget,
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined,
  opaque: CheckpointOpaqueArtifact | undefined,
  cas: CheckpointCasStore
): Promise<boolean> {
  let complete = budget.append(`--- ${before ? `a/${file}` : "/dev/null"}\n+++ ${after ? `b/${file}` : "/dev/null"}\n`);
  complete = budget.append(`[metadata before=${metadata(before)} after=${metadata(after)}]\n`) && complete;
  complete = budget.append("[before]\n") && complete;
  complete = await appendContent(budget, before, opaque?.before, cas) && complete;
  complete = budget.append("\n[after]\n") && complete;
  complete = await appendContent(budget, after, opaque?.after, cas) && complete;
  complete = budget.append("\n") && complete;
  return complete && !budget.truncated;
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
  if (maxBytes < TRUNCATION_MARKER_BYTES) {
    throw new RangeError(`Checkpoint review maxBytes must be at least ${TRUNCATION_MARKER_BYTES}.`);
  }
  const budget = new ReviewBudget(maxBytes);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const opaqueByPath = new Map(opaqueArtifacts.map((artifact) => [artifact.path, artifact]));
  const reviewDiffPaths: string[] = [];
  const changed = [...new Set([
    ...checkpoint.delta!.added,
    ...checkpoint.delta!.modified,
    ...checkpoint.delta!.deleted
  ])].sort();
  for (const file of changed) {
    const opaque = opaqueByPath.get(file);
    if (fullyOpaque(checkpoint, file, opaque)) continue;
    if (budget.availableOutput <= 0 || budget.truncated) {
      budget.markTruncated();
      break;
    }
    const complete = await appendSection(
      budget,
      file,
      beforeByPath.get(file),
      afterByPath.get(file),
      opaque,
      cas
    );
    if (complete) reviewDiffPaths.push(file);
    if (budget.truncated) break;
  }
  return { reviewDiff: budget.value(), reviewDiffPaths, opaqueArtifacts };
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
