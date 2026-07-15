import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readPatchFile } from "./atomic-patch-file-state.js";
import {
  AtomicPatchError,
  type FilePatch,
  type HunkLine,
  type PatchHunk
} from "./atomic-patch-parser.js";
import type { PatchOriginalFile, PreparedPatchChange } from "./atomic-patch-types.js";
import { resolveWorkspacePath } from "agent-platform";

const PROTECTED_SEGMENTS = new Set([".git", ".agent"]);
const WINDOWS_ILLEGAL = /[<>:"|?*]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function patchFileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safePatchRelative(raw: string): string {
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

/**
 * Resolve a patch path against the canonical workspace and only then expose a
 * relative path to the mutation machinery.  This deliberately keeps
 * safePatchRelative as the final lexical guard: absolute paths are accepted
 * only when they resolve inside this workspace, while traversal and link
 * escapes remain rejected.
 */
export async function normalizePatchRelative(workspace: string, raw: string): Promise<string> {
  const root = await realpath(path.resolve(workspace));
  const target = await resolveWorkspacePath(root, raw);
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative) throw new AtomicPatchError(`Patch cannot replace the workspace root: '${raw}'.`);
  return safePatchRelative(relative);
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

export async function verifyPatchParentContainment(workspace: string, relative: string): Promise<void> {
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
  if (source && expected[source] && expected[source] !== patchFileHash(original.bytes)) {
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

export async function preparePatchChange(
  workspace: string,
  patch: FilePatch,
  expected: Record<string, string>
): Promise<PreparedPatchChange> {
  const source = patch.oldPath ? await normalizePatchRelative(workspace, patch.oldPath) : undefined;
  const target = patch.newPath ? await normalizePatchRelative(workspace, patch.newPath) : undefined;
  if (source) await verifyPatchParentContainment(workspace, source);
  if (target) await verifyPatchParentContainment(workspace, target);
  const original = await readPatchFile(workspace, source);
  await assertPatchPreconditions(workspace, patch, source, target, original, expected);
  if (!target) return { source, original };
  return await preparedTarget(workspace, patch, source, target, original);
}
