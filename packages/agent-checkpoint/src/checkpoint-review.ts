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

type DiffOperation = { kind: "equal" | "delete" | "insert"; line: string };

function appendOperations(
  target: DiffOperation[],
  lines: readonly string[],
  kind: DiffOperation["kind"],
  start = 0,
  end = lines.length
): void {
  for (let index = start; index < end; index += 1) {
    target.push({ kind, line: lines[index]! });
  }
}

function textLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines;
}

function uniqueLineAnchors(
  before: readonly string[],
  after: readonly string[]
): Array<{ before: number; after: number }> {
  const left = new Map<string, number[]>();
  const right = new Map<string, number[]>();
  before.forEach((line, index) => {
    const positions = left.get(line);
    if (positions) positions.push(index);
    else left.set(line, [index]);
  });
  after.forEach((line, index) => {
    const positions = right.get(line);
    if (positions) positions.push(index);
    else right.set(line, [index]);
  });
  const candidates = [...left].flatMap(([line, positions]) => {
    const matching = right.get(line);
    return positions.length === 1 && matching?.length === 1
      ? [{ before: positions[0]!, after: matching[0]! }]
      : [];
  }).sort((a, b) => a.before - b.before);
  const tails: number[] = [];
  const tailIndices: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (const [index, candidate] of candidates.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < candidate.after) low = middle + 1;
      else high = middle;
    }
    tails[low] = candidate.after;
    previous[index] = low > 0 ? tailIndices[low - 1]! : -1;
    tailIndices[low] = index;
  }
  const anchors: Array<{ before: number; after: number }> = [];
  let cursor = tailIndices.at(-1) ?? -1;
  while (cursor >= 0) {
    anchors.push(candidates[cursor]!);
    cursor = previous[cursor]!;
  }
  return anchors.reverse();
}

function lineOperations(before: string, after: string): DiffOperation[] {
  const left = textLines(before);
  const right = textLines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length
    && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
    suffix += 1;
  }
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const anchors = uniqueLineAnchors(leftMiddle, rightMiddle);
  const operations: DiffOperation[] = [];
  appendOperations(operations, left, "equal", 0, prefix);
  let leftCursor = 0;
  let rightCursor = 0;
  for (const anchor of anchors) {
    appendOperations(operations, leftMiddle, "delete", leftCursor, anchor.before);
    appendOperations(operations, rightMiddle, "insert", rightCursor, anchor.after);
    operations.push({ kind: "equal", line: leftMiddle[anchor.before]! });
    leftCursor = anchor.before + 1;
    rightCursor = anchor.after + 1;
  }
  appendOperations(operations, leftMiddle, "delete", leftCursor);
  appendOperations(operations, rightMiddle, "insert", rightCursor);
  appendOperations(operations, left, "equal", left.length - suffix);
  return operations;
}

function unifiedHunks(before: string, after: string): string {
  const operations = lineOperations(before, after);
  const changes = operations.flatMap((operation, index) =>
    operation.kind === "equal" ? [] : [index]);
  if (changes.length === 0) return "";
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changes) {
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }) => {
    const body = operations.slice(start, end);
    const oldBefore = operations.slice(0, start)
      .filter((operation) => operation.kind !== "insert").length;
    const newBefore = operations.slice(0, start)
      .filter((operation) => operation.kind !== "delete").length;
    const oldCount = body.filter((operation) => operation.kind !== "insert").length;
    const newCount = body.filter((operation) => operation.kind !== "delete").length;
    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    const lines = body.map((operation) =>
      `${operation.kind === "equal" ? " " : operation.kind === "delete" ? "-" : "+"}${operation.line}`);
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join("\n")}\n`;
  }).join("");
}

async function renderSection(
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined,
  opaque: CheckpointOpaqueArtifact | undefined,
  cas: CheckpointCasStore
): Promise<string> {
  const header = `[metadata before=${metadata(before)} after=${metadata(after)}]\n`
    + `--- ${before ? `a/${file}` : "/dev/null"}\n`
    + `+++ ${after ? `b/${file}` : "/dev/null"}\n`;
  const textual = (!before || before.kind === "file")
    && (!after || after.kind === "file")
    && !opaque?.before && !opaque?.after;
  if (textual) {
    const previous = await renderedContent(before, undefined, cas);
    const current = await renderedContent(after, undefined, cas);
    return `${header}${unifiedHunks(previous === "[absent]" ? "" : previous,
      current === "[absent]" ? "" : current)}`;
  }
  return `${header}[before]\n${await renderedContent(before, opaque?.before, cas)}\n`
    + `[after]\n${await renderedContent(after, opaque?.after, cas)}\n`;
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

function renderableTextFile(
  entry: CheckpointEntry | undefined,
  opaqueIdentity: OpaqueIdentity | undefined
): boolean {
  return entry?.kind === "file" && opaqueIdentity === undefined;
}

async function boundedTextSection(
  file: string,
  before: CheckpointEntry | undefined,
  after: CheckpointEntry | undefined,
  opaque: CheckpointOpaqueArtifact | undefined,
  cas: CheckpointCasStore,
  maxBytes: number
): Promise<string | undefined> {
  const beforeText = renderableTextFile(before, opaque?.before);
  const afterText = renderableTextFile(after, opaque?.after);
  const textInputBytes = (beforeText ? before!.size : 0)
    + (afterText ? after!.size : 0);
  const oneSidedText = (!before && afterText) || (!after && beforeText);
  // An added or deleted text file is represented line-for-line, so content
  // larger than the remaining review envelope cannot possibly fit. Preserve
  // its authenticated identity instead of allocating an unbounded line diff.
  const cannotFitOneSidedContent = oneSidedText && textInputBytes > maxBytes;
  return !cannotFitOneSidedContent && textInputBytes <= 64 * 1024 * 1024
    ? await renderSection(file, before, after, opaque, cas)
    : undefined;
}

function replaceOpaqueArtifact(
  artifacts: readonly CheckpointOpaqueArtifact[],
  file: string,
  omitted: CheckpointOpaqueArtifact
): CheckpointOpaqueArtifact[] {
  const existingIndex = artifacts.findIndex((artifact) => artifact.path === file);
  if (existingIndex < 0) return [...artifacts, omitted];
  return artifacts.map((artifact, index) =>
    index === existingIndex ? omitted : artifact);
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
    const section = await boundedTextSection(
      file,
      beforeEntry,
      afterEntry,
      opaque,
      cas,
      maxBytes - representedBytes(diffParts, artifacts)
    );
    if (section && representedBytes([...diffParts, section], artifacts) <= maxBytes) {
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
    const nextArtifacts = replaceOpaqueArtifact(artifacts, file, omitted);
    if (representedBytes(diffParts, nextArtifacts) > maxBytes) {
      return reviewScopeTooLarge(
        "Changed-path identity metadata exceeds the bounded review scope.",
        "Remove generated or temporary artifacts, or split the change into a smaller checkpoint."
      );
    }
    artifacts.length = 0;
    for (const artifact of nextArtifacts) artifacts.push(artifact);
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
