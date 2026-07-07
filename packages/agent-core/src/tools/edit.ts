import { readFile, writeFile } from "node:fs/promises";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { requestToolPermission, resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

interface EditArgs {
  path?: unknown;
  oldString?: unknown;
  newString?: unknown;
  expectedReplacements?: unknown;
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = source.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

export async function executeEditTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as EditArgs;
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    return { ok: false, content: "edit requires a path string" };
  }
  if (typeof parsed.oldString !== "string" || parsed.oldString.length === 0) {
    return { ok: false, content: "edit requires a non-empty oldString" };
  }
  if (typeof parsed.newString !== "string") {
    return { ok: false, content: "edit requires newString as a string" };
  }

  let filePath: string;
  try {
    filePath = resolveWorkspacePath(context.workspacePath, parsed.path);
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
  const relativePath = workspaceRelativePath(context.workspacePath, filePath);

  const denied = await requestToolPermission(context, {
    toolName: "edit",
    arguments: args,
    risk: "write",
    reason: `Replace text in ${relativePath}`
  });
  if (denied) return denied;

  try {
    const original = await readFile(filePath, "utf8");
    const replacements = countOccurrences(original, parsed.oldString);
    if (replacements === 0) {
      return {
        ok: false,
        content: `oldString was not found in ${parsed.path}. File begins with:\n${original.slice(0, 400)}`
      };
    }

    if (
      typeof parsed.expectedReplacements === "number" &&
      Number.isFinite(parsed.expectedReplacements) &&
      replacements !== parsed.expectedReplacements
    ) {
      return {
        ok: false,
        content: `Expected ${parsed.expectedReplacements} replacement(s), found ${replacements}. No changes written.`,
        metadata: { replacements }
      };
    }

    const updated = original.split(parsed.oldString).join(parsed.newString);
    await writeFile(filePath, updated, "utf8");
    context.runState.changedFiles.add(relativePath);
    return {
      ok: true,
      content: `Edited ${relativePath} (${replacements} replacement(s))`,
      metadata: { path: filePath, relativePath, replacements }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
