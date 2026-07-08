import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { resolveWorkspacePath } from "../policy.js";

interface ReadArgs {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

interface ReadManyArgs {
  files?: unknown;
  maxCharsPerFile?: unknown;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function workspaceDisplayPath(workspacePath: string, filePath: string): string {
  return path.relative(workspacePath, filePath).split(path.sep).join("/") || ".";
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
        metadata: { path: filePath, sizeBytes: info.size, binary: true, truncated: false }
      };
    }

    const offset = numberOrDefault(parsed.offset, 0);
    const limit = numberOrDefault(parsed.limit, buffer.length - offset);
    const slice = buffer.subarray(offset, Math.min(buffer.length, offset + limit));
    const text = slice.toString("utf8");
    const truncated = truncateMiddle(text, context.maxToolOutputChars);

    return {
      ok: true,
      content: truncated.text,
      metadata: {
        path: filePath,
        sizeBytes: info.size,
        offset,
        limit,
        binary: false,
        truncated: truncated.truncated || offset + limit < buffer.length
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
  const maxCharsPerFile = numberOrDefault(parsed.maxCharsPerFile, Math.min(6000, context.maxToolOutputChars));
  const results: Array<Record<string, unknown>> = [];
  const sections: string[] = [];
  let allOk = true;

  for (const item of files.slice(0, 50)) {
    const pathValue = typeof item.path === "string" ? item.path : "";
    const result = await executeReadTool(
      {
        path: pathValue,
        offset: item.offset,
        limit: item.limit ?? maxCharsPerFile
      },
      { ...context, maxToolOutputChars: maxCharsPerFile }
    );
    allOk &&= result.ok;
    const metadata = result.metadata ?? {};
    const displayPath = typeof metadata.path === "string"
      ? workspaceDisplayPath(context.workspacePath, metadata.path)
      : pathValue || "(invalid)";
    sections.push([`--- ${displayPath} ---`, result.content].join("\n"));
    results.push({
      ok: result.ok,
      ...metadata,
      path: displayPath
    });
  }

  const truncated = truncateMiddle(sections.join("\n\n"), context.maxToolOutputChars);
  return {
    ok: allOk,
    content: truncated.text,
    metadata: {
      files: results,
      truncated: truncated.truncated
    }
  };
}
