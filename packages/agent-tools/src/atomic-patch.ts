import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDelta } from "agent-protocol";
import { readPatchFile, samePatchFile } from "./atomic-patch-file-state.js";
import { AtomicPatchError, parseUnifiedPatch, type FilePatch, type HunkLine, type PatchHunk } from "./atomic-patch-parser.js";
import { commitPreparedPatch, type AtomicPatchCleanupWarning } from "./atomic-patch-transaction.js";
import type {
  AtomicPatchMutation, PatchOriginalFile, PreparedPatchChange
} from "./atomic-patch-types.js";

export { AtomicPatchError, parseUnifiedPatch } from "./atomic-patch-parser.js";
export { AtomicPatchCleanupError, AtomicPatchRollbackError } from "./atomic-patch-transaction.js";
export type { AtomicPatchMutation } from "./atomic-patch-types.js";

export interface AtomicPatchOptions {
  preimageHashes?: Record<string, string>;
  /** Test/integration synchronization point; callers cannot supply this through the model tool schema. */
  beforeCommit?: () => Promise<void>;
  /** Test-only fault-injection point; callers cannot supply this through the model tool schema. */
  beforeMutation?: (operation: AtomicPatchMutation) => Promise<void>;
}

export interface AtomicPatchResult {
  files: string[];
  delta: WorkspaceDelta;
  preimageHashes: Record<string, string>;
  postimageHashes: Record<string, string>;
  cleanupWarning?: AtomicPatchCleanupWarning;
}

const PROTECTED_SEGMENTS = new Set([".git", ".agent"]);
const WINDOWS_ILLEGAL = /[<>:"|?*]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(raw: string): string {
  const normalized = raw.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.includes("\0")
    || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new AtomicPatchError(`Unsafe patch path '${raw}'.`);
  }
  const parts = normalized.split("/");
  const unsafe = parts.some((part) => part === "" || part === "." || part === ".."
    || PROTECTED_SEGMENTS.has(part.toLowerCase()) || WINDOWS_ILLEGAL.test(part)
    || /[. ]$/u.test(part) || WINDOWS_RESERVED.test(part));
  if (unsafe) throw new AtomicPatchError(`Protected or unsafe patch path '${raw}'.`);
  return parts.join("/");
}

function rangeStart(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function tailLine(hunk: PatchHunk, side: "old" | "new"): HunkLine | undefined {
  for (let index = hunk.lines.length - 1; index >= 0; index -= 1) {
    const line = hunk.lines[index]!;
    if ((side === "old" && line.kind !== "add") || (side === "new" && line.kind !== "delete")) return line;
  }
  return undefined;
}

function newlineTails(
  original: PatchOriginalFile,
  hunk: PatchHunk,
  touchesEof: boolean
): { oldTail?: HunkLine; newTail?: HunkLine } {
  const marked = hunk.lines.filter((line) => line.noNewline);
  if (marked.length > 0 && !touchesEof) throw new AtomicPatchError("No-newline marker does not describe the end of the file.");
  const oldTail = tailLine(hunk, "old");
  const newTail = tailLine(hunk, "new");
  for (const line of marked) {
    if ((line.kind !== "add" && line !== oldTail) || (line.kind !== "delete" && line !== newTail)) {
      throw new AtomicPatchError("Misplaced no-newline marker.");
    }
  }
  if (oldTail?.noNewline && original.finalNewline) {
    throw new AtomicPatchError("Patch newline context does not match the source file.");
  }
  return { oldTail, newTail };
}

function nextFinalNewline(
  original: PatchOriginalFile,
  hunk: PatchHunk,
  touchesEof: boolean,
  current: boolean
): boolean {
  const { oldTail, newTail } = newlineTails(original, hunk, touchesEof);
  if (!touchesEof) return current;
  if (newTail?.noNewline) return false;
  if (oldTail?.noNewline || !original.exists) return true;
  return current;
}

function applyHunks(original: PatchOriginalFile, hunks: readonly PatchHunk[]): string {
  if (hunks.length === 0) return original.content;
  const normalized = original.content.replaceAll("\r\n", "\n");
  const input = normalized === "" ? [] : normalized.replace(/\n$/u, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let finalNewline = original.finalNewline;
  for (const hunk of hunks) {
    const start = rangeStart(hunk.oldStart, hunk.oldCount);
    if (start < cursor) throw new AtomicPatchError("Overlapping patch hunks are not allowed.");
    if (start > input.length) throw new AtomicPatchError("Patch hunk starts beyond the end of the source file.");
    output.push(...input.slice(cursor, start));
    const expectedNewStart = rangeStart(hunk.newStart, hunk.newCount);
    if (output.length !== expectedNewStart) throw new AtomicPatchError("Patch hunk new-file position is inconsistent.");
    cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "add") output.push(line.text);
      else {
        if (input[cursor] !== line.text) {
          throw new AtomicPatchError(`Patch context mismatch at original line ${cursor + 1}.`);
        }
        if (line.kind === "context") output.push(line.text);
        cursor += 1;
      }
    }
    const touchesEof = start + hunk.oldCount === input.length;
    finalNewline = nextFinalNewline(original, hunk, touchesEof, finalNewline);
  }
  output.push(...input.slice(cursor));
  return output.join(original.eol) + (finalNewline && output.length > 0 ? original.eol : "");
}

async function verifyParentContainment(workspace: string, relative: string): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AtomicPatchError(`Patch parent is not a contained directory: ${relative}`);
    }
  }
}

function validateGitMode(mode: number, label: string): void {
  const kind = mode & 0o170000;
  const unsupportedKind = kind !== 0o100000 && kind !== 0o120000;
  const specialPermissions = kind === 0o100000 && (mode & 0o7000) !== 0;
  const invalidSymlink = kind === 0o120000 && mode !== 0o120000;
  if (unsupportedKind || specialPermissions || invalidSymlink) {
    throw new AtomicPatchError(`Unsupported ${label} '${mode.toString(8)}'.`);
  }
}

function assertOldMode(patch: FilePatch, original: PatchOriginalFile): void {
  if (patch.oldMode === undefined) return;
  validateGitMode(patch.oldMode, "old file mode");
  const actualKind = original.kind === "symlink" ? 0o120000 : 0o100000;
  if ((patch.oldMode & 0o170000) !== actualKind) throw new AtomicPatchError("Old file mode kind does not match the source.");
  if (process.platform !== "win32" && actualKind === 0o100000
    && Boolean(patch.oldMode & 0o111) !== Boolean(original.mode & 0o111)) {
    throw new AtomicPatchError("Old file executable mode does not match the source.");
  }
}

async function validateSymlinkTarget(workspace: string, relative: string, content: string): Promise<void> {
  if (!content || content.includes("\0") || /[\r\n]/u.test(content)
    || path.posix.isAbsolute(content) || path.win32.isAbsolute(content) || /^[A-Za-z]:/u.test(content)) {
    throw new AtomicPatchError(`Unsafe symlink target for '${relative}'.`);
  }
  const portableParts = content.replaceAll("\\", "/").split("/");
  const linkParent = path.dirname(path.join(workspace, ...relative.split("/")));
  const resolved = path.resolve(linkParent, ...portableParts);
  const fromRoot = path.relative(workspace, resolved);
  const escaped = fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot);
  const protectedTarget = fromRoot.split(path.sep).some((part) => PROTECTED_SEGMENTS.has(part.toLowerCase()));
  if (escaped || protectedTarget) throw new AtomicPatchError(`Unsafe symlink target for '${relative}'.`);
  let current = workspace;
  for (const part of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new AtomicPatchError(`Unsafe symlink target for '${relative}'.`);
    if (!info.isDirectory()) break;
  }
}

async function assertPatchPreconditions(
  workspace: string,
  patch: FilePatch,
  source: string | undefined,
  target: string | undefined,
  original: PatchOriginalFile,
  expected: Record<string, string>
): Promise<void> {
  if (source && !original.exists) throw new AtomicPatchError(`Patch source does not exist: ${source}`);
  if (!source && patch.oldMode !== undefined) throw new AtomicPatchError("A new file cannot declare an old mode.");
  if (!target && patch.newMode !== undefined) throw new AtomicPatchError("A deleted file cannot declare a new mode.");
  if (source) assertOldMode(patch, original);
  if (source && expected[source] && expected[source] !== hash(original.bytes)) {
    throw new AtomicPatchError(`Preimage hash mismatch: ${source}`);
  }
  if (target && target !== source && (await readPatchFile(workspace, target)).exists) {
    throw new AtomicPatchError(`Patch destination already exists: ${target}`);
  }
}

async function preparedTarget(
  workspace: string,
  patch: FilePatch,
  source: string | undefined,
  target: string,
  original: PatchOriginalFile
): Promise<PreparedPatchChange> {
  if (patch.newMode !== undefined) validateGitMode(patch.newMode, "new file mode");
  const mode = patch.newMode ?? original.mode;
  const kind = (mode & 0o170000) === 0o120000 ? "symlink" : "file";
  const patched = applyHunks(original, patch.hunks);
  const content = kind === "symlink" ? patched.replace(/\r?\n$/u, "") : patched;
  if (kind === "symlink") await validateSymlinkTarget(workspace, target, content);
  return { source, target, original, content, kind, mode };
}

async function prepare(
  workspace: string,
  patch: FilePatch,
  expected: Record<string, string>
): Promise<PreparedPatchChange> {
  const source = patch.oldPath ? safeRelative(patch.oldPath) : undefined;
  const target = patch.newPath ? safeRelative(patch.newPath) : undefined;
  if (source) await verifyParentContainment(workspace, source);
  if (target) await verifyParentContainment(workspace, target);
  const original = await readPatchFile(workspace, source);
  await assertPatchPreconditions(workspace, patch, source, target, original, expected);
  if (!target) return { source, original };
  return await preparedTarget(workspace, patch, source, target, original);
}

function uniqueTouched(changes: readonly PreparedPatchChange[]): Set<string> {
  const touched = new Set<string>();
  for (const change of changes) {
    const paths = [change.source, change.target].filter((value): value is string => Boolean(value));
    for (const item of new Set(paths)) {
      if (touched.has(item)) throw new AtomicPatchError(`Patch changes '${item}' more than once.`);
      touched.add(item);
    }
  }
  const sorted = [...touched].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.startsWith(`${sorted[index - 1]!}/`)) {
      throw new AtomicPatchError(`Patch paths overlap: '${sorted[index - 1]}' and '${sorted[index]}'.`);
    }
  }
  return touched;
}

async function assertSourceUnchanged(workspace: string, change: PreparedPatchChange): Promise<void> {
  await verifyParentContainment(workspace, change.source!);
  const current = await readPatchFile(workspace, change.source);
  if (!samePatchFile(current, change.original)) {
    throw new AtomicPatchError(`Patch source changed before commit: ${change.source}`);
  }
}

async function assertTargetAbsent(workspace: string, change: PreparedPatchChange): Promise<void> {
  await verifyParentContainment(workspace, change.target!);
  if ((await readPatchFile(workspace, change.target)).exists) {
    throw new AtomicPatchError(`Patch destination changed before commit: ${change.target}`);
  }
}

async function assertPreparedChangesUnchanged(
  workspace: string,
  changes: readonly PreparedPatchChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.source) await assertSourceUnchanged(workspace, change);
    if (change.target && change.target !== change.source) await assertTargetAbsent(workspace, change);
  }
}

async function assertWorkspaceRestored(
  workspace: string,
  changes: readonly PreparedPatchChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.source) await assertSourceUnchanged(workspace, change);
    if (change.target && change.target !== change.source && (await readPatchFile(workspace, change.target)).exists) {
      throw new AtomicPatchError(`Rollback left a destination in place: ${change.target}`);
    }
  }
}

function summarizeChange(
  change: PreparedPatchChange,
  preimageHashes: Record<string, string>,
  postimageHashes: Record<string, string>,
  delta: WorkspaceDelta
): void {
  if (change.source) preimageHashes[change.source] = hash(change.original.bytes);
  if (!change.source && change.target) delta.added.push(change.target);
  else if (change.source && !change.target) delta.deleted.push(change.source);
  else if (change.source === change.target) delta.modified.push(change.target!);
  else {
    delta.deleted.push(change.source!);
    delta.added.push(change.target!);
  }
  if (change.target) postimageHashes[change.target] = hash(Buffer.from(change.content!, "utf8"));
}

function patchResult(
  changes: readonly PreparedPatchChange[],
  touched: ReadonlySet<string>,
  cleanupWarning?: AtomicPatchCleanupWarning
): AtomicPatchResult {
  const preimageHashes: Record<string, string> = {};
  const postimageHashes: Record<string, string> = {};
  const delta: WorkspaceDelta = { added: [], modified: [], deleted: [] };
  for (const change of changes) summarizeChange(change, preimageHashes, postimageHashes, delta);
  for (const values of [delta.added, delta.modified, delta.deleted]) values.sort();
  return {
    files: [...touched].sort(), delta, preimageHashes, postimageHashes,
    ...(cleanupWarning ? { cleanupWarning } : {})
  };
}

export async function applyUnifiedPatch(
  workspacePath: string,
  source: string,
  options: AtomicPatchOptions = {}
): Promise<AtomicPatchResult> {
  const workspace = await realpath(path.resolve(workspacePath));
  const patches = parseUnifiedPatch(source);
  const changes = await Promise.all(patches.map(async (patch) =>
    await prepare(workspace, patch, options.preimageHashes ?? {})));
  const touched = uniqueTouched(changes);
  const transaction = path.join(workspace, `.sigma-patch-${randomUUID()}`);
  const cleanupWarning = await commitPreparedPatch({
    workspace, transaction, changes,
    beforeCommit: options.beforeCommit,
    beforeMutation: options.beforeMutation,
    validators: {
      assertAllUnchanged: async () => await assertPreparedChangesUnchanged(workspace, changes),
      assertSourceUnchanged: async (change) => await assertSourceUnchanged(workspace, change),
      assertTargetAbsent: async (change) => await assertTargetAbsent(workspace, change),
      assertRestored: async () => await assertWorkspaceRestored(workspace, changes)
    }
  });
  return patchResult(changes, touched, cleanupWarning);
}
