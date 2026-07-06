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

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
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
        content: `Binary file: ${path.relative(context.workspacePath, filePath)} (${info.size} bytes)`,
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
