import type { CheckpointCasStore } from "./cas-store.js";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointRecord
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

  append(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength <= this.outputRemaining) {
      this.parts.push(value);
      this.outputRemaining -= bytes.byteLength;
      return;
    }
    if (this.outputRemaining > 0) {
      const decoder = new TextDecoder("utf-8");
      this.parts.push(decoder.decode(bytes.subarray(0, this.outputRemaining), { stream: true }));
    }
    this.outputRemaining = 0;
    this.truncated = true;
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

function metadata(entry: CheckpointEntry | undefined): string {
  return entry ? `${entry.kind}:${entry.mode}` : "absent";
}

function decodeText(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

async function appendContent(
  budget: ReviewBudget,
  entry: CheckpointEntry | undefined,
  cas: CheckpointCasStore
): Promise<void> {
  if (!entry) {
    budget.append("[absent]");
    return;
  }
  if (entry.kind === "directory") {
    budget.append("[directory]");
    return;
  }
  if (entry.kind === "symlink") {
    budget.append(`[symlink -> ${entry.linkTarget ?? ""}]`);
    return;
  }
  const limit = Math.min(budget.availableOutput, budget.availableRead);
  if (limit <= 0) {
    budget.markTruncated();
    return;
  }
  if (!entry.casIdentity) {
    throw new CheckpointConflictError(`Checkpoint manifest lacks a trusted CAS identity: ${entry.path}`);
  }
  const prefix = await cas.readPrefix(entry.digest!, limit, entry.casIdentity);
  budget.recordRead(prefix.content.byteLength);
  const text = decodeText(prefix.content);
  if (text === null) {
    budget.append(`[binary sha256=${entry.digest} size=${entry.size}]`);
  } else {
    budget.append(text);
  }
  if (prefix.truncated) {
    budget.markTruncated();
    budget.append("\n[content truncated]");
  }
}

async function appendSection(
  budget: ReviewBudget,
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined,
  cas: CheckpointCasStore
): Promise<void> {
  budget.append(`--- ${before ? `a/${file}` : "/dev/null"}\n+++ ${after ? `b/${file}` : "/dev/null"}\n`);
  budget.append(`[metadata before=${metadata(before)} after=${metadata(after)}]\n`);
  budget.append("[before]\n");
  await appendContent(budget, before, cas);
  budget.append("\n[after]\n");
  await appendContent(budget, after, cas);
  budget.append("\n");
}

export async function buildCheckpointReview(
  checkpoint: CheckpointRecord,
  before: CheckpointManifest,
  after: CheckpointManifest,
  cas: CheckpointCasStore,
  maxBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Checkpoint review maxBytes must be a non-negative safe integer.");
  }
  if (maxBytes < TRUNCATION_MARKER_BYTES) {
    throw new RangeError(`Checkpoint review maxBytes must be at least ${TRUNCATION_MARKER_BYTES}.`);
  }
  const budget = new ReviewBudget(maxBytes);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changed = [...new Set([
    ...checkpoint.delta!.added,
    ...checkpoint.delta!.modified,
    ...checkpoint.delta!.deleted
  ])].sort();
  for (const file of changed) {
    if (budget.availableOutput <= 0) {
      budget.markTruncated();
      break;
    }
    await appendSection(budget, file, beforeByPath.get(file), afterByPath.get(file), cas);
  }
  return budget.value();
}
