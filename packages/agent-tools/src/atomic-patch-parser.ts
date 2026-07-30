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
  /**
   * Codex apply_patch chunks locate their preimage by content instead of by
   * numeric unified-diff ranges. Presence of this object selects that mode.
   */
  search?: {
    changeContext?: string;
    endOfFile?: boolean;
  };
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

const CODEX_BEGIN_PATCH = "*** Begin Patch";
const CODEX_END_PATCH = "*** End Patch";
const CODEX_ADD_FILE = "*** Add File: ";
const CODEX_DELETE_FILE = "*** Delete File: ";
const CODEX_UPDATE_FILE = "*** Update File: ";
const CODEX_MOVE_TO = "*** Move to: ";
const CODEX_END_OF_FILE = "*** End of File";

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

function codexPatchPath(line: string, marker: string, lineNumber: number): string {
  const value = line.slice(marker.length).trim();
  if (!value) throw new AtomicPatchError(`Missing patch path at line ${lineNumber}.`);
  return value;
}

function codexFileHeader(line: string): boolean {
  return line.startsWith(CODEX_ADD_FILE)
    || line.startsWith(CODEX_DELETE_FILE)
    || line.startsWith(CODEX_UPDATE_FILE);
}

function contextHunk(changeContext?: string): PatchHunk {
  return {
    oldStart: 0,
    oldCount: 0,
    newStart: 0,
    newCount: 0,
    lines: [],
    search: {
      ...(changeContext !== undefined ? { changeContext } : {})
    }
  };
}

function finishContextHunk(hunk: PatchHunk, lineNumber: number): void {
  if (hunk.lines.length === 0) {
    throw new AtomicPatchError(`Patch update chunk at line ${lineNumber} contains no changes or context.`);
  }
  const counts = countedLines(hunk);
  hunk.oldCount = counts.old;
  hunk.newCount = counts.new;
}

function parseCodexAdd(
  lines: readonly string[],
  start: number,
  end: number,
  patches: FilePatch[]
): number {
  const path = codexPatchPath(lines[start]!, CODEX_ADD_FILE, start + 1);
  const hunk: PatchHunk = {
    oldStart: 0, oldCount: 0, newStart: 1, newCount: 0, lines: []
  };
  let index = start + 1;
  while (index < end && !codexFileHeader(lines[index]!) && lines[index] !== CODEX_END_PATCH) {
    const line = lines[index]!;
    if (!line.startsWith("+")) {
      throw new AtomicPatchError(`Invalid add-file content at line ${index + 1}; every line must start with '+'.`);
    }
    hunk.lines.push({ kind: "add", text: line.slice(1) });
    index += 1;
  }
  if (hunk.lines.length === 0) {
    throw new AtomicPatchError(`Add-file section for '${path}' contains no content lines.`);
  }
  hunk.newCount = hunk.lines.length;
  patches.push({ newPath: path, hunks: [hunk] });
  return index;
}

function parseCodexDelete(
  lines: readonly string[],
  start: number,
  patches: FilePatch[]
): number {
  const oldPath = codexPatchPath(lines[start]!, CODEX_DELETE_FILE, start + 1);
  patches.push({ oldPath, hunks: [] });
  return start + 1;
}

function codexUpdateContinues(lines: readonly string[], index: number, end: number): boolean {
  return index < end && !codexFileHeader(lines[index]!) && lines[index] !== CODEX_END_PATCH;
}

function appendCodexUpdateLine(
  active: PatchHunk | undefined,
  line: string,
  lineNumber: number
): PatchHunk {
  const hunk = active ?? contextHunk();
  if (line.startsWith("+")) hunk.lines.push({ kind: "add", text: line.slice(1) });
  else if (line.startsWith("-")) hunk.lines.push({ kind: "delete", text: line.slice(1) });
  else if (line.startsWith(" ")) hunk.lines.push({ kind: "context", text: line.slice(1) });
  else {
    throw new AtomicPatchError(
      `Invalid update content at line ${lineNumber}; expected '@@' or a line starting with '+', '-', or space.`
    );
  }
  return hunk;
}

function markCodexEndOfFile(
  active: PatchHunk | undefined,
  lines: readonly string[],
  nextIndex: number,
  end: number
): PatchHunk {
  if (!active) {
    throw new AtomicPatchError(`Misplaced end-of-file marker at line ${nextIndex}.`);
  }
  active.search = { ...active.search, endOfFile: true };
  if (codexUpdateContinues(lines, nextIndex, end)) {
    throw new AtomicPatchError(`End-of-file marker at line ${nextIndex} must finish its file section.`);
  }
  return active;
}

function parseCodexUpdate(
  lines: readonly string[],
  start: number,
  end: number,
  patches: FilePatch[]
): number {
  const oldPath = codexPatchPath(lines[start]!, CODEX_UPDATE_FILE, start + 1);
  let newPath = oldPath;
  let index = start + 1;
  if (index < end && lines[index]!.startsWith(CODEX_MOVE_TO)) {
    newPath = codexPatchPath(lines[index]!, CODEX_MOVE_TO, index + 1);
    index += 1;
  }
  const hunks: PatchHunk[] = [];
  let active: PatchHunk | undefined;
  const finishActive = (): void => {
    if (!active) return;
    finishContextHunk(active, index);
    hunks.push(active);
    active = undefined;
  };
  while (codexUpdateContinues(lines, index, end)) {
    const line = lines[index]!;
    if (line === "@@" || line.startsWith("@@ ")) {
      finishActive();
      active = contextHunk(line === "@@" ? undefined : line.slice(3));
      index += 1;
      continue;
    }
    if (line === CODEX_END_OF_FILE) {
      index += 1;
      active = markCodexEndOfFile(active, lines, index, end);
      continue;
    }
    active = appendCodexUpdateLine(active, line, index + 1);
    index += 1;
  }
  finishActive();
  patches.push({ oldPath, newPath, hunks });
  return index;
}

function parseCodexPatch(source: string): FilePatch[] {
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== CODEX_BEGIN_PATCH) {
    throw new AtomicPatchError(`The first patch line must be '${CODEX_BEGIN_PATCH}'.`);
  }
  if (lines.at(-1)?.trim() !== CODEX_END_PATCH) {
    throw new AtomicPatchError(`The last patch line must be '${CODEX_END_PATCH}'.`);
  }
  const patches: FilePatch[] = [];
  const end = lines.length - 1;
  let index = 1;
  while (index < end) {
    const line = lines[index]!;
    if (line.startsWith(CODEX_ADD_FILE)) {
      index = parseCodexAdd(lines, index, end, patches);
    } else if (line.startsWith(CODEX_DELETE_FILE)) {
      index = parseCodexDelete(lines, index, patches);
    } else if (line.startsWith(CODEX_UPDATE_FILE)) {
      index = parseCodexUpdate(lines, index, end, patches);
    } else {
      throw new AtomicPatchError(
        `Invalid patch operation at line ${index + 1}; expected Add File, Delete File, or Update File.`
      );
    }
  }
  if (patches.length === 0) throw new AtomicPatchError("Patch contains no file changes.");
  for (const patch of patches) validateFilePatch(patch);
  return patches;
}

function parseGitUnifiedPatch(source: string): FilePatch[] {
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

export function parseUnifiedPatch(source: string): FilePatch[] {
  return source.replaceAll("\r\n", "\n").trimStart().startsWith(CODEX_BEGIN_PATCH)
    ? parseCodexPatch(source)
    : parseGitUnifiedPatch(source);
}
