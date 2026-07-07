import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { requestToolPermission, resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

interface WriteArgs {
  path?: unknown;
  content?: unknown;
  createDirs?: unknown;
}

export async function executeWriteTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
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

  const relativePath = workspaceRelativePath(context.workspacePath, filePath);
  const denied = await requestToolPermission(context, {
    toolName: "write",
    arguments: args,
    risk: "write",
    reason: `Write UTF-8 file ${relativePath}`
  });
  if (denied) return denied;

  try {
    if (parsed.createDirs === true) {
      await mkdir(path.dirname(filePath), { recursive: true });
    }
    await writeFile(filePath, parsed.content, "utf8");
    context.runState.changedFiles.add(relativePath);
    return {
      ok: true,
      content: `Wrote ${relativePath}`,
      metadata: {
        path: filePath,
        relativePath,
        changedFiles: [relativePath],
        bytes: Buffer.byteLength(parsed.content, "utf8")
      }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
