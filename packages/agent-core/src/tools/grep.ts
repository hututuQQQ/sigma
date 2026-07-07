import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { workspaceRelativePath } from "../policy.js";
import {
  explicitPathIncludesIgnored,
  resolveWorkspaceRelativePath,
  walkFiles
} from "./workspace-utils.js";
import { matchesSimpleGlob } from "./glob.js";

interface GrepArgs {
  pattern?: unknown;
  path?: unknown;
  glob?: unknown;
  caseSensitive?: unknown;
  contextLines?: unknown;
  maxMatches?: unknown;
}

interface GrepMatch {
  path: string;
  line: number;
  snippet: string;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

async function tryRipgrep(options: {
  pattern: string;
  rootPath: string;
  workspacePath: string;
  glob?: string;
  caseSensitive: boolean;
  maxMatches: number;
}): Promise<{ matches: GrepMatch[]; unavailable?: boolean; error?: string }> {
  const rootArg = workspaceRelativePath(options.workspacePath, options.rootPath) || ".";
  const args = ["--json", "--line-number", "--color=never"];
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.glob) args.push("--glob", options.glob);
  for (const ignored of [".git", "node_modules", "dist", "coverage", ".artifacts"]) {
    args.push("--glob", `!${ignored}/**`);
  }
  args.push(options.pattern, rootArg);

  return await new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: options.workspacePath, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let unavailable = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      unavailable = true;
    });
    child.on("close", (code) => {
      if (unavailable) {
        resolve({ matches: [], unavailable: true });
        return;
      }
      if (code !== 0 && code !== 1) {
        resolve({ matches: [], error: stderr.trim() || `rg exited with code ${code}` });
        return;
      }
      const matches: GrepMatch[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (event.type !== "match") continue;
          const matchPath = event.data?.path?.text;
          const lineNumber = event.data?.line_number;
          const text = event.data?.lines?.text;
          if (typeof matchPath !== "string" || typeof lineNumber !== "number" || typeof text !== "string") continue;
          matches.push({ path: matchPath.split(path.sep).join("/"), line: lineNumber, snippet: text.trimEnd() });
          if (matches.length >= options.maxMatches) break;
        } catch {
          // Ignore malformed rg JSON lines and keep any valid matches already parsed.
        }
      }
      resolve({ matches });
    });
  });
}

async function fallbackGrep(options: {
  pattern: string;
  rootPath: string;
  rootRelative: string;
  workspacePath: string;
  glob?: string;
  caseSensitive: boolean;
  contextLines: number;
  maxMatches: number;
}): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, options.caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`);
  }

  const info = await stat(options.rootPath);
  const files = info.isFile()
    ? {
        files: [{ absolutePath: options.rootPath, relativePath: workspaceRelativePath(options.workspacePath, options.rootPath) }],
        truncated: false
      }
    : await walkFiles({
        workspacePath: options.workspacePath,
        rootPath: options.rootPath,
        maxFiles: 100000,
        explicitIncludesIgnored: explicitPathIncludesIgnored(options.rootRelative)
      });

  const matches: GrepMatch[] = [];
  for (const file of files.files) {
    if (options.glob) {
      const relativeToRoot = path.relative(options.rootPath, file.absolutePath).split(path.sep).join("/");
      if (!matchesSimpleGlob(options.glob, relativeToRoot)) continue;
    }
    const buffer = await readFile(file.absolutePath);
    if (isBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      const start = Math.max(0, index - options.contextLines);
      const end = Math.min(lines.length - 1, index + options.contextLines);
      const snippet = lines.slice(start, end + 1).join("\n");
      matches.push({ path: file.relativePath, line: index + 1, snippet });
      if (matches.length >= options.maxMatches) return { matches, truncated: true };
    }
  }
  return { matches, truncated: files.truncated };
}

export async function executeGrepTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as GrepArgs;
  if (typeof parsed.pattern !== "string" || parsed.pattern.length === 0) {
    return { ok: false, content: "grep requires a pattern string" };
  }
  const requestedPath = typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : ".";
  const glob = typeof parsed.glob === "string" && parsed.glob.length > 0 ? parsed.glob : undefined;
  const caseSensitive = parsed.caseSensitive !== false;
  const contextLines = numberOrDefault(parsed.contextLines, 0, 0, 20);
  const maxMatches = numberOrDefault(parsed.maxMatches, 100, 1, 5000);

  let rootPath: string;
  let rootRelative: string;
  try {
    const resolved = resolveWorkspaceRelativePath(context.workspacePath, requestedPath);
    rootPath = resolved.absolutePath;
    rootRelative = resolved.relativePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  try {
    if (contextLines === 0) {
      const rg = await tryRipgrep({
        pattern: parsed.pattern,
        rootPath,
        workspacePath: context.workspacePath,
        glob,
        caseSensitive,
        maxMatches
      });
      if (rg.error) return { ok: false, content: rg.error };
      if (!rg.unavailable) {
        const truncated = rg.matches.length >= maxMatches;
        const content = JSON.stringify({ matches: rg.matches, truncated }, null, 2);
        const truncatedContent = truncateMiddle(content, context.maxToolOutputChars);
        return {
          ok: true,
          content: truncatedContent.text,
          metadata: { matches: rg.matches, truncated: truncated || truncatedContent.truncated, engine: "rg" }
        };
      }
    }

    const result = await fallbackGrep({
      pattern: parsed.pattern,
      rootPath,
      rootRelative,
      workspacePath: context.workspacePath,
      glob,
      caseSensitive,
      contextLines,
      maxMatches
    });
    const content = JSON.stringify({ matches: result.matches, truncated: result.truncated }, null, 2);
    const truncatedContent = truncateMiddle(content, context.maxToolOutputChars);
    return {
      ok: true,
      content: truncatedContent.text,
      metadata: { matches: result.matches, truncated: result.truncated || truncatedContent.truncated, engine: "node" }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

