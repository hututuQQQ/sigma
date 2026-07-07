import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import {
  explicitPathIncludesIgnored,
  resolveWorkspaceRelativePath,
  walkFiles
} from "./workspace-utils.js";

interface GlobArgs {
  pattern?: unknown;
  cwd?: unknown;
  maxMatches?: unknown;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function validatePattern(pattern: string): string | null {
  if (!pattern.trim()) return "glob requires a non-empty pattern";
  if (path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern)) return "glob pattern must be workspace-relative";
  const normalized = normalizePattern(pattern);
  if (normalized.split("/").some((segment) => segment === "..")) return "glob pattern must not contain '..'";
  return null;
}

function segmentMatches(patternSegment: string, value: string): boolean {
  let expression = "^";
  for (const char of patternSegment) {
    if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  expression += "$";
  return new RegExp(expression).test(value);
}

function matchSegments(patternSegments: string[], pathSegments: string[], patternIndex = 0, pathIndex = 0): boolean {
  if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === "**") {
    if (patternIndex === patternSegments.length - 1) return true;
    for (let index = pathIndex; index <= pathSegments.length; index += 1) {
      if (matchSegments(patternSegments, pathSegments, patternIndex + 1, index)) return true;
    }
    return false;
  }
  if (pathIndex >= pathSegments.length) return false;
  return segmentMatches(patternSegment, pathSegments[pathIndex]) &&
    matchSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1);
}

export function matchesSimpleGlob(pattern: string, relativePath: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const patternSegments = normalizedPattern.split("/").filter((segment) => segment.length > 0);
  const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  return matchSegments(patternSegments, pathSegments);
}

export async function executeGlobTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as GlobArgs;
  if (typeof parsed.pattern !== "string") {
    return { ok: false, content: "glob requires a pattern string" };
  }
  const validationError = validatePattern(parsed.pattern);
  if (validationError) return { ok: false, content: validationError };

  const requestedCwd = typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : ".";
  const maxMatches = numberOrDefault(parsed.maxMatches, 200, 1, 5000);
  let cwdPath: string;
  let cwdRelative: string;
  try {
    const resolved = resolveWorkspaceRelativePath(context.workspacePath, requestedCwd);
    cwdPath = resolved.absolutePath;
    cwdRelative = resolved.relativePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  try {
    const files = await walkFiles({
      workspacePath: context.workspacePath,
      rootPath: cwdPath,
      maxFiles: Math.max(maxMatches * 20, maxMatches),
      explicitIncludesIgnored: explicitPathIncludesIgnored(cwdRelative)
    });
    const matches: string[] = [];
    for (const file of files.files) {
      const relativeToCwd = path.relative(cwdPath, file.absolutePath).split(path.sep).join("/");
      if (matchesSimpleGlob(parsed.pattern, relativeToCwd)) {
        matches.push(file.relativePath);
        if (matches.length >= maxMatches) break;
      }
    }
    const truncated = files.truncated || matches.length >= maxMatches;
    const content = JSON.stringify({ matches, truncated }, null, 2);
    const truncatedContent = truncateMiddle(content, context.maxToolOutputChars);
    return {
      ok: true,
      content: truncatedContent.text,
      metadata: { matches, truncated: truncated || truncatedContent.truncated, cwd: cwdRelative }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

