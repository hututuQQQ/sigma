import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { resolveWorkspacePath } from "../policy.js";

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
  if (context.permissionMode !== "yolo") {
    return {
      ok: false,
      content: "Permission mode 'ask' is non-interactive in this MVP; edit is rejected."
    };
  }

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
    return {
      ok: true,
      content: `Edited ${path.relative(context.workspacePath, filePath)} (${replacements} replacement(s))`,
      metadata: { path: filePath, replacements }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
