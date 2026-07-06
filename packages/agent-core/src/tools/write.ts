import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { resolveWorkspacePath } from "../policy.js";

interface WriteArgs {
  path?: unknown;
  content?: unknown;
  createDirs?: unknown;
}

export async function executeWriteTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  if (context.permissionMode !== "yolo") {
    return {
      ok: false,
      content: "Permission mode 'ask' is non-interactive in this MVP; write is rejected."
    };
  }

  const parsed = (args && typeof args === "object" ? args : {}) as WriteArgs;
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    return { ok: false, content: "write requires a path string" };
  }
  if (typeof parsed.content !== "string") {
    return { ok: false, content: "write requires content as a string" };
  }

  let filePath: string;
  try {
    filePath = resolveWorkspacePath(context.workspacePath, parsed.path);
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  try {
    if (parsed.createDirs === true) {
      await mkdir(path.dirname(filePath), { recursive: true });
    }
    await writeFile(filePath, parsed.content, "utf8");
    return {
      ok: true,
      content: `Wrote ${path.relative(context.workspacePath, filePath)}`,
      metadata: {
        path: filePath,
        bytes: Buffer.byteLength(parsed.content, "utf8")
      }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
