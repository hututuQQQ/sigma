export interface HunkLine {
  kind: "context" | "add" | "delete";
  text: string;
  noNewline?: boolean;
}
export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface FilePatch {
  oldPath?: string;
  newPath?: string;
  oldMode?: number;
  newMode?: number;
  hunks: PatchHunk[];
}

interface PatchParserState {
  current?: FilePatch;
  hunk?: PatchHunk;
}

export class AtomicPatchError extends Error {
  readonly code = "atomic_patch_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AtomicPatchError";
  }
}

function cleanPatchPath(raw: string): string | undefined {
  const value = raw.trim().split("\t", 1)[0];
  if (value === "/dev/null") return undefined;
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

function parseMode(raw: string): number {
  const normalized = raw.trim();
  if (!/^[0-7]{6}$/u.test(normalized)) throw new AtomicPatchError(`Invalid file mode '${raw}'.`);
  const value = Number.parseInt(normalized, 8);
  return value;
}

function hunkHeader(line: string): PatchHunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (!match) throw new AtomicPatchError(`Invalid hunk header: ${line}`);
  const hunk = {
    oldStart: Number(match[1]), oldCount: Number(match[2] ?? "1"),
    newStart: Number(match[3]), newCount: Number(match[4] ?? "1"), lines: []
  };
  const values = [hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount];
  if (values.some((value) => !Number.isSafeInteger(value))
    || (hunk.oldCount > 0 && hunk.oldStart === 0)
    || (hunk.newCount > 0 && hunk.newStart === 0)) {
    throw new AtomicPatchError(`Invalid hunk range: ${line}`);
  }
  return hunk;
}

function parseDiffHeader(line: string, state: PatchParserState, patches: FilePatch[]): boolean {
  if (!line.startsWith("diff --git ")) return false;
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
  if (!match) throw new AtomicPatchError(`Invalid diff header: ${line}`);
  state.current = { oldPath: match[1], newPath: match[2], hunks: [] };
  state.hunk = undefined;
  patches.push(state.current);
  return true;
}

function countedLines(hunk: PatchHunk): { old: number; new: number } {
  return {
    old: hunk.lines.filter((line) => line.kind !== "add").length,
    new: hunk.lines.filter((line) => line.kind !== "delete").length
  };
}

function parseHunkContent(line: string, state: PatchParserState, ensure: () => FilePatch): boolean {
  if (line.startsWith("@@ ")) {
    state.hunk = hunkHeader(line);
    ensure().hunks.push(state.hunk);
    return true;
  }
  if (!state.hunk) return false;
  if (line === "\\ No newline at end of file") {
    const previous = state.hunk.lines.at(-1);
    if (!previous || previous.noNewline) throw new AtomicPatchError("Misplaced no-newline marker.");
    previous.noNewline = true;
    return true;
  }
  const before = countedLines(state.hunk);
  if (before.old === state.hunk.oldCount && before.new === state.hunk.newCount) {
    state.hunk = undefined;
    return false;
  }
  if (line.startsWith("+")) state.hunk.lines.push({ kind: "add", text: line.slice(1) });
  else if (line.startsWith("-")) state.hunk.lines.push({ kind: "delete", text: line.slice(1) });
  else if (line.startsWith(" ")) state.hunk.lines.push({ kind: "context", text: line.slice(1) });
  else throw new AtomicPatchError(`Invalid hunk content: ${line}`);
  const after = countedLines(state.hunk);
  if (after.old > state.hunk.oldCount || after.new > state.hunk.newCount) {
    throw new AtomicPatchError("Hunk contains more lines than its header declares.");
  }
  return true;
}

function parseFileMetadata(line: string, ensure: () => FilePatch): void {
  if (line.startsWith("rename from ")) ensure().oldPath = line.slice("rename from ".length);
  else if (line.startsWith("rename to ")) ensure().newPath = line.slice("rename to ".length);
  else if (line.startsWith("old mode ")) ensure().oldMode = parseMode(line.slice("old mode ".length));
  else if (line.startsWith("new mode ")) ensure().newMode = parseMode(line.slice("new mode ".length));
  else if (line.startsWith("new file mode ")) {
    ensure().oldPath = undefined;
    ensure().newMode = parseMode(line.slice("new file mode ".length));
  } else if (line.startsWith("deleted file mode ")) {
    ensure().newPath = undefined;
    ensure().oldMode = parseMode(line.slice("deleted file mode ".length));
  } else if (line.startsWith("--- ")) ensure().oldPath = cleanPatchPath(line.slice(4));
  else if (line.startsWith("+++ ")) ensure().newPath = cleanPatchPath(line.slice(4));
}

function parsePatchLine(
  line: string,
  state: PatchParserState,
  patches: FilePatch[],
  ensure: () => FilePatch
): void {
  if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
    throw new AtomicPatchError("Binary patches are not supported.");
  }
  if (parseDiffHeader(line, state, patches)) return;
  if (parseHunkContent(line, state, ensure)) return;
  parseFileMetadata(line, ensure);
}

function validateHunk(hunk: PatchHunk): void {
  const oldLines = hunk.lines.filter((line) => line.kind !== "add").length;
  const newLines = hunk.lines.filter((line) => line.kind !== "delete").length;
  if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
    throw new AtomicPatchError("Hunk line counts do not match its header.");
  }
}

function validateFilePatch(patch: FilePatch): void {
  if (!patch.oldPath && !patch.newPath) throw new AtomicPatchError("Patch file has neither source nor destination path.");
  for (const hunk of patch.hunks) validateHunk(hunk);
  const pathChanged = patch.oldPath !== patch.newPath;
  const modeChanged = patch.oldMode !== patch.newMode
    && (patch.oldMode !== undefined || patch.newMode !== undefined);
  if (patch.hunks.length === 0 && !pathChanged && !modeChanged) {
    throw new AtomicPatchError("Patch file contains no content, path, or mode change.");
  }
}

export function parseUnifiedPatch(source: string): FilePatch[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const patches: FilePatch[] = [];
  const state: PatchParserState = {};
  const ensure = (): FilePatch => {
    state.current ??= { hunks: [] };
    if (!patches.includes(state.current)) patches.push(state.current);
    return state.current;
  };
  for (const line of lines) parsePatchLine(line, state, patches, ensure);
  if (patches.length === 0) throw new AtomicPatchError("Patch contains no file changes.");
  for (const patch of patches) validateFilePatch(patch);
  return patches;
}
