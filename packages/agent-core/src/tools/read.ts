import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ReadFileState, ToolExecutionContext, ToolResult } from "../types.js";
import { resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

interface ReadArgs {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
  byteOffset?: unknown;
  byteLimit?: unknown;
}

interface ReadManyArgs {
  files?: unknown;
  maxCharsPerFile?: unknown;
}

const DEFAULT_LINE_LIMIT = 2000;
const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier read tool result in this conversation is still current; refer to that instead of re-reading.";

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function workspaceDisplayPath(workspacePath: string, filePath: string): string {
  return path.relative(workspacePath, filePath).split(path.sep).join("/") || ".";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readState(context: ToolExecutionContext): Map<string, ReadFileState> {
  const existing = context.runState.readFileState;
  if (existing) return existing;
  const created = new Map<string, ReadFileState>();
  context.runState.readFileState = created;
  return created;
}

function readCacheKey(relativePath: string, range: {
  startLine?: number;
  limit?: number;
  byteOffset?: number;
  byteLimit?: number;
}): string {
  return [
    relativePath,
    range.startLine ?? "",
    range.limit ?? "",
    range.byteOffset ?? "",
    range.byteLimit ?? ""
  ].join(":");
}

function unchangedReadResult(options: {
  state: ReadFileState;
  path: string;
  cacheKey: string;
}): ToolResult {
  return {
    ok: true,
    content: FILE_UNCHANGED_STUB,
    metadata: {
      path: options.path,
      relativePath: options.state.relativePath,
      sizeBytes: options.state.sizeBytes,
      mtimeMs: options.state.mtimeMs,
      startLine: options.state.startLine,
      offset: options.state.startLine,
      limit: options.state.limit,
      byteOffset: options.state.byteOffset,
      byteLimit: options.state.byteLimit,
      binary: false,
      truncated: false,
      cacheHit: true,
      cacheKey: options.cacheKey
    }
  };
}

export function invalidateReadFileState(context: ToolExecutionContext, relativePath: string): void {
  const state = context.runState.readFileState;
  if (!state) return;
  const normalized = relativePath.split(path.sep).join("/");
  for (const key of [...state.keys()]) {
    if (key === normalized || key.startsWith(`${normalized}:`)) {
      state.delete(key);
    }
  }
}

function splitLines(buffer: Buffer): string[] {
  const raw = buffer.toString("utf8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.split("\n");
}

function formatLine(lineNumber: number, text: string): string {
  return `${String(lineNumber).padStart(6, " ")}\t${text}`;
}

function formatLinesWithBudget(lines: string[], startLine: number, maxChars: number): {
  content: string;
  lineCount: number;
  truncatedByChars: boolean;
} {
  const selected: string[] = [];
  let chars = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const formatted = formatLine(startLine + index, lines[index] ?? "");
    const nextChars = chars + formatted.length + (selected.length > 0 ? 1 : 0);
    if (nextChars > maxChars) {
      if (selected.length === 0) {
        selected.push(formatted.slice(0, Math.max(0, maxChars)));
      }
      return { content: selected.join("\n"), lineCount: selected.length, truncatedByChars: true };
    }
    selected.push(formatted);
    chars = nextChars;
  }
  return { content: selected.join("\n"), lineCount: selected.length, truncatedByChars: false };
}

function limitTextByChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars)), truncated: true };
}

async function executeReadBytes(options: {
  args: ReadArgs;
  context: ToolExecutionContext;
  filePath: string;
  relativePath: string;
  buffer: Buffer;
  sizeBytes: number;
  mtimeMs: number;
}): Promise<ToolResult> {
  const byteOffset = optionalNonNegativeInteger(options.args.byteOffset) ?? 0;
  const byteLimit = optionalPositiveInteger(options.args.byteLimit) ?? Math.max(0, options.buffer.length - byteOffset);
  const cacheKey = readCacheKey(options.relativePath, { byteOffset, byteLimit });
  const cached = readState(options.context).get(cacheKey);
  if (
    cached &&
    cached.sizeBytes === options.sizeBytes &&
    cached.mtimeMs === options.mtimeMs &&
    cached.byteOffset === byteOffset &&
    cached.byteLimit === byteLimit
  ) {
    return unchangedReadResult({ state: cached, path: options.filePath, cacheKey });
  }

  const slice = options.buffer.subarray(byteOffset, Math.min(options.buffer.length, byteOffset + byteLimit));
  const limited = limitTextByChars(slice.toString("utf8"), options.context.maxToolOutputChars);
  const truncated = limited.truncated || byteOffset + byteLimit < options.buffer.length;
  readState(options.context).set(cacheKey, {
    path: options.filePath,
    relativePath: options.relativePath,
    sizeBytes: options.sizeBytes,
    mtimeMs: options.mtimeMs,
    byteOffset,
    byteLimit,
    contentHash: hashText(limited.text)
  });

  return {
    ok: true,
    content: limited.text,
    metadata: {
      path: options.filePath,
      relativePath: options.relativePath,
      sizeBytes: options.sizeBytes,
      mtimeMs: options.mtimeMs,
      byteOffset,
      byteLimit,
      binary: false,
      truncated,
      ...(truncated ? { truncatedReason: limited.truncated ? "output_chars" : "byte_range" } : {})
    }
  };
}

export async function executeReadTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ReadArgs;
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    return { ok: false, content: "read requires a path string" };
  }

  let filePath: string;
  try {
    filePath = resolveWorkspacePath(context.workspacePath, parsed.path);
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
  const relativePath = workspaceRelativePath(context.workspacePath, filePath);

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { ok: false, content: `Path is not a file: ${parsed.path}` };
    }

    const buffer = await readFile(filePath);
    if (isBinary(buffer)) {
      return {
        ok: true,
        content: `Binary file: ${workspaceDisplayPath(context.workspacePath, filePath)} (${info.size} bytes)`,
        metadata: { path: filePath, relativePath, sizeBytes: info.size, mtimeMs: info.mtimeMs, binary: true, truncated: false }
      };
    }

    if (parsed.byteOffset !== undefined || parsed.byteLimit !== undefined) {
      return await executeReadBytes({
        args: parsed,
        context,
        filePath,
        relativePath,
        buffer,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs
      });
    }

    const startLine = Math.max(1, positiveInteger(parsed.offset, 1));
    const limit = positiveInteger(parsed.limit, DEFAULT_LINE_LIMIT);
    const cacheKey = readCacheKey(relativePath, { startLine, limit });
    const cached = readState(context).get(cacheKey);
    if (
      cached &&
      cached.sizeBytes === info.size &&
      cached.mtimeMs === info.mtimeMs &&
      cached.startLine === startLine &&
      cached.limit === limit
    ) {
      return unchangedReadResult({ state: cached, path: filePath, cacheKey });
    }

    const lines = splitLines(buffer);
    const startIndex = startLine - 1;
    const selected = startIndex < lines.length ? lines.slice(startIndex, startIndex + limit) : [];
    const formatted = formatLinesWithBudget(selected, startLine, context.maxToolOutputChars);
    const outOfRange = startIndex >= lines.length;
    const content = outOfRange
      ? `Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${lines.length} lines.`
      : formatted.content;
    const truncatedByLineLimit = startIndex + limit < lines.length;
    const truncated = formatted.truncatedByChars || truncatedByLineLimit;

    readState(context).set(cacheKey, {
      path: filePath,
      relativePath,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      startLine,
      limit,
      contentHash: hashText(content)
    });

    return {
      ok: true,
      content,
      metadata: {
        path: filePath,
        relativePath,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        startLine,
        offset: startLine,
        limit,
        lineCount: formatted.lineCount,
        totalLines: lines.length,
        binary: false,
        truncated,
        ...(truncated
          ? { truncatedReason: formatted.truncatedByChars ? "output_chars" : "line_limit" }
          : {})
      }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

function readManyItems(value: unknown): ReadArgs[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return { path: item };
    return item && typeof item === "object" ? item as ReadArgs : {};
  });
}

export async function executeReadManyTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ReadManyArgs;
  const files = readManyItems(parsed.files);
  if (files.length === 0) {
    return { ok: false, content: "read_many requires files as an array of paths or read request objects" };
  }
  const maxCharsPerFile = positiveInteger(parsed.maxCharsPerFile, Math.min(6000, context.maxToolOutputChars));
  const results: Array<Record<string, unknown>> = [];
  const sections: string[] = [];
  let allOk = true;

  for (const item of files.slice(0, 50)) {
    const pathValue = typeof item.path === "string" ? item.path : "";
    const result = await executeReadTool(
      {
        path: pathValue,
        offset: item.offset,
        limit: item.limit,
        byteOffset: item.byteOffset,
        byteLimit: item.byteLimit
      },
      { ...context, maxToolOutputChars: maxCharsPerFile }
    );
    allOk &&= result.ok;
    const metadata = result.metadata ?? {};
    const displayPath = typeof metadata.relativePath === "string"
      ? metadata.relativePath
      : typeof metadata.path === "string"
        ? workspaceDisplayPath(context.workspacePath, metadata.path)
        : pathValue || "(invalid)";
    sections.push([`--- ${displayPath} ---`, result.content].join("\n"));
    results.push({
      ok: result.ok,
      ...metadata,
      path: displayPath
    });
  }

  const limited = limitTextByChars(sections.join("\n\n"), context.maxToolOutputChars);
  return {
    ok: allOk,
    content: limited.text,
    metadata: {
      files: results,
      truncated: limited.truncated
    }
  };
}
