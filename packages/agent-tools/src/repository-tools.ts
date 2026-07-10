import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import { resolveWorkspacePath, runProcess, selfContainedGitRoot } from "agent-platform";
import type { RegisteredEffectTool } from "./registry.js";

function object(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(input: Record<string, JsonValue>, key: string, fallback = ""): string {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  return value;
}

function integer(input: Record<string, JsonValue>, key: string, fallback: number, maximum: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Tool argument '${key}' must be a number.`);
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function schema(input: Omit<ToolDescriptor, "inputSchema"> & { properties: Record<string, JsonValue>; required?: string[] }): ToolDescriptor {
  return { ...input, inputSchema: { type: "object", properties: input.properties, required: input.required ?? [], additionalProperties: false } };
}

function result(
  request: ToolRequest,
  startedAt: string,
  output: string,
  ok = true,
  diagnostics: string[] = [],
  artifacts: string[] = []
): ToolReceipt {
  return { callId: request.callId, ok, output, observedEffects: ["filesystem.read"], artifacts, diagnostics, startedAt, completedAt: new Date().toISOString() };
}

const ignoredDirectories = new Set([".git", ".agent", "node_modules", "dist", "coverage"]);

async function walk(root: string, relativeRoot: string, limit: number, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const queue = [relativeRoot];
  while (queue.length > 0 && files.length < limit) {
    if (signal.aborted) throw signal.reason ?? new Error("Repository scan cancelled.");
    const relative = queue.shift()!;
    const directory = await resolveWorkspacePath(root, relative || ".");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) queue.push(child);
      } else if (entry.isFile()) {
        files.push(child.split(path.sep).join("/"));
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

function listTool(): RegisteredEffectTool {
  return {
    descriptor: schema({
      name: "list",
      description: "List repository files recursively with optional glob filtering. Standard generated/vendor directories are skipped.",
      properties: { path: { type: "string" }, glob: { type: "string" }, limit: { type: "number" } },
      contextPathArguments: ["path"],
      possibleEffects: ["filesystem.read"], executionMode: "parallel", resourceKeys: [], approval: "auto", idempotent: true, timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const limit = integer(input, "limit", 2_000, 20_000);
      const files = await walk(context.workspacePath, text(input, "path", "."), limit, context.signal);
      const pattern = text(input, "glob");
      const selected = pattern ? files.filter((file) => globExpression(pattern).test(file)) : files;
      return result(request, startedAt, selected.join("\n"), true, files.length >= limit ? [`result_limit=${limit}`] : []);
    }
  };
}

async function fallbackSearch(
  workspace: string,
  searchPath: string,
  query: string,
  regex: boolean,
  limit: number,
  signal: AbortSignal
): Promise<{ matches: string[]; truncated: boolean }> {
  const matcher = regex ? new RegExp(query, "u") : null;
  const files = await walk(workspace, searchPath, 20_000, signal);
  const matches: string[] = [];
  for (const file of files) {
    if (matches.length > limit) break;
    const target = await resolveWorkspacePath(workspace, file);
    if ((await stat(target)).size > 2_000_000) continue;
    const content = await readFile(target, "utf8").catch(() => "");
    if (content.includes("\0")) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (matcher ? matcher.test(line) : line.includes(query)) matches.push(`${file}:${index + 1}:${line}`);
      if (matches.length > limit) break;
    }
  }
  return { matches: matches.slice(0, limit), truncated: matches.length > limit };
}

function grepTool(): RegisteredEffectTool {
  return {
    descriptor: schema({
      name: "grep",
      description: "Search repository text with ripgrep semantics and a built-in fallback.",
      properties: { query: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, regex: { type: "boolean" }, limit: { type: "number" } },
      required: ["query"], possibleEffects: ["filesystem.read", "process.spawn.readonly"], executionMode: "parallel", resourceKeys: [],
      contextPathArguments: ["path"], approval: "auto", idempotent: true, timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const query = text(input, "query");
      const searchPath = text(input, "path", ".");
      const workspaceRoot = await resolveWorkspacePath(context.workspacePath, ".");
      const resolvedSearchPath = await resolveWorkspacePath(workspaceRoot, searchPath);
      const safeSearchPath = path.relative(workspaceRoot, resolvedSearchPath) || ".";
      const limit = integer(input, "limit", 500, 5_000);
      const regex = input.regex === true;
      const argv = ["--line-number", "--column", "--no-heading", "--color", "never"];
      if (!regex) argv.push("--fixed-strings");
      const glob = text(input, "glob");
      if (glob) argv.push("--glob", glob);
      argv.push("--", query, safeSearchPath);
      try {
        const output = await runProcess({
          executable: "rg", args: argv, cwd: workspaceRoot, timeoutMs: 30_000,
          maxStdoutLines: limit + 1, signal: context.signal
        });
        if (output.exitCode === 0 || output.exitCode === 1 || output.stdoutLimitReached) {
          const matches = output.stdout.trimEnd().split(/\r?\n/u).filter(Boolean);
          const truncated = matches.length > limit;
          const diagnostics = [
            ...(output.exitCode === 1 ? ["no_matches"] : []),
            ...(truncated ? [`result_limit=${limit}`] : []),
            ...(output.outputTruncated ? ["output_truncated=true"] : [])
          ];
          return result(request, startedAt, matches.slice(0, limit).join("\n"), true, diagnostics);
        }
      } catch {
        // Use the portable scanner when ripgrep is unavailable.
      }
      const fallback = await fallbackSearch(workspaceRoot, safeSearchPath, query, regex, limit, context.signal);
      return result(
        request, startedAt, fallback.matches.join("\n"), true,
        fallback.truncated ? [`result_limit=${limit}`] : []
      );
    }
  };
}

const gitDiffPreviewCharacters = 32_000;
const gitCaptureCharacters = 64 * 1024 * 1024;

function gitDiffPreview(output: string, artifact: string): string {
  const half = gitDiffPreviewCharacters / 2;
  const omitted = output.length - gitDiffPreviewCharacters;
  return [
    output.slice(0, half),
    `\n... [${omitted} characters omitted; complete Git diff artifact: ${artifact}] ...\n`,
    output.slice(-half)
  ].join("");
}

function gitReadTool(name: "git_status" | "git_diff", args: string[], description: string): RegisteredEffectTool {
  return {
    descriptor: schema({
      name, description, properties: {}, possibleEffects: ["filesystem.read", "process.spawn.readonly"], executionMode: "parallel",
      resourceKeys: ["workspace:git-read"], approval: "auto", idempotent: true, timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const repositoryRoot = await selfContainedGitRoot(context.workspacePath, context.signal);
      if (!repositoryRoot) {
        return result(request, startedAt, "Workspace is not a self-contained Git repository.", false, ["workspace_not_git_root"]);
      }
      const output = await runProcess({
        executable: "git", args, cwd: repositoryRoot, timeoutMs: 30_000,
        maxOutputBytes: name === "git_diff" ? gitCaptureCharacters : 2_000_000,
        signal: context.signal
      });
      const complete = [output.stdout, output.stderr].filter(Boolean).join("\n");
      const diagnostics = [`exit_code=${output.exitCode}`];
      if (name !== "git_diff" || complete.length <= gitDiffPreviewCharacters) {
        return result(request, startedAt, complete, output.exitCode === 0, diagnostics);
      }
      const artifact = await context.createArtifact({ name: "git-diff.patch", content: complete });
      return result(
        request,
        startedAt,
        gitDiffPreview(complete, artifact),
        output.exitCode === 0,
        [...diagnostics, `output_truncated=${complete.length - gitDiffPreviewCharacters}`, `artifact=${artifact}`],
        [artifact]
      );
    }
  };
}

export function repositoryTools(): RegisteredEffectTool[] {
  return [
    listTool(),
    grepTool(),
    gitReadTool("git_status", ["status", "--short", "--branch"], "Show the repository branch and working-tree status without changing it."),
    gitReadTool("git_diff", ["diff", "--no-ext-diff", "--stat", "--patch"], "Show the current unstaged Git diff without changing it.")
  ];
}
