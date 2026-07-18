import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import {
  runProcess,
  repositoryTopology,
  type ProcessExecutionPort
} from "agent-platform";
import type { RegisteredEffectTool } from "./registry.js";

export type RepositoryStatisticsProvider = (
  workspace: string,
  signal: AbortSignal
) => Promise<RepositoryProviderResult>;

export interface RepositoryProviderResult {
  output: string;
  diagnostics?: string[];
}

export interface RepositoryListRequest {
  path: string;
  glob: string;
  limit: number;
}

export type RepositoryListProvider = (
  workspace: string,
  signal: AbortSignal,
  request: RepositoryListRequest
) => Promise<RepositoryProviderResult>;

export interface RepositoryTextSearchRequest {
  query: string;
  path: string;
  glob: string;
  regex: boolean;
  limit: number;
}

export type RepositoryTextSearchProvider = (
  workspace: string,
  signal: AbortSignal,
  request: RepositoryTextSearchRequest
) => Promise<RepositoryProviderResult>;

export interface RepositoryToolProviders {
  list?: RepositoryListProvider;
  statistics?: RepositoryStatisticsProvider;
  textSearch?: RepositoryTextSearchProvider;
}

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

const listGlobCharacterLimit = 512;
const maximumListEntries = 20_000;
const maximumSearchMatches = 5_000;

function listTool(listProvider: RepositoryListProvider): RegisteredEffectTool {
  return {
    descriptor: schema({
      name: "list",
      description: "List repository files recursively as bounded JSONL paths with optional glob filtering. Glob syntax supports literals, /, *, ?, and **. Nested ignore rules and hidden, generated, vendor, control, sensitive, symbolic-link, and directory reparse-point paths are excluded; diagnostics state completeness.",
      properties: {
        path: { type: "string" }, glob: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: maximumListEntries }
      },
      contextPathArguments: ["path"],
      possibleEffects: ["filesystem.read"], executionMode: "parallel", resourceKeys: [], approval: "auto", idempotent: true, timeoutMs: 45_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const limit = integer(input, "limit", 2_000, maximumListEntries);
      const searchPath = text(input, "path", ".");
      const pattern = text(input, "glob");
      if (pattern.length > listGlobCharacterLimit) {
        throw new Error(`List glob exceeds the ${listGlobCharacterLimit}-character safety limit.`);
      }
      let listing: RepositoryProviderResult;
      try {
        listing = await listProvider(
          context.workspacePath,
          context.signal,
          { path: searchPath, glob: pattern, limit }
        );
      } catch (error) {
        if (error instanceof Error
          && "code" in error
          && error.code === "unsupported_repository_glob_syntax") {
          return result(
            request,
            startedAt,
            error.message,
            false,
            ["unsupported_repository_glob_syntax"]
          );
        }
        throw error;
      }
      return result(request, startedAt, listing.output, true, listing.diagnostics ?? []);
    }
  };
}

function repositoryStatsTool(statisticsProvider: RepositoryStatisticsProvider): RegisteredEffectTool {
  return {
    descriptor: schema({
      name: "repository_stats",
      description: "Count accepted source files and physical/non-blank text lines from one repository snapshot by language and bounded top-level directory groups without starting a process; returns scope, read limits, and completeness, and exposes no partial aggregates when its deadline is reached.",
      properties: {}, possibleEffects: ["filesystem.read"], executionMode: "parallel",
      resourceKeys: [], approval: "auto", idempotent: true, timeoutMs: 45_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const statistics = await statisticsProvider(context.workspacePath, context.signal);
      return result(request, startedAt, statistics.output, true, statistics.diagnostics ?? []);
    }
  };
}

function grepTool(searchProvider: RepositoryTextSearchProvider): RegisteredEffectTool {
  return {
    descriptor: schema({
      name: "grep",
      description: "Search bounded safe repository text without spawning a process. Hidden, ignored, generated, symbolic-link, directory reparse-point, hard-linked, and sensitive paths are excluded. Matching is literal unless regex=true; results are JSONL.",
      properties: {
        query: { type: "string" }, path: { type: "string" }, glob: { type: "string" },
        regex: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: maximumSearchMatches }
      },
      required: ["query"], possibleEffects: ["filesystem.read"], executionMode: "parallel", resourceKeys: [],
      contextPathArguments: ["path"], approval: "auto", idempotent: true, timeoutMs: 45_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const query = text(input, "query");
      const searchPath = text(input, "path", ".");
      const limit = integer(input, "limit", 500, maximumSearchMatches);
      const regex = input.regex === true;
      const glob = text(input, "glob");
      const search = await searchProvider(
        context.workspacePath,
        context.signal,
        { query, path: searchPath, glob, regex, limit }
      );
      return result(request, startedAt, search.output, true, search.diagnostics ?? []);
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

function gitReadTool(
  name: "git_status" | "git_diff",
  args: string[],
  description: string,
  execution?: ProcessExecutionPort
): RegisteredEffectTool {
  return {
    descriptor: schema({
      name, description, properties: {}, possibleEffects: ["filesystem.read", "process.spawn.readonly"], executionMode: "parallel",
      resourceKeys: ["workspace:git-read"], approval: "auto", idempotent: true, timeoutMs: 45_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      let topology;
      try {
        topology = execution
          ? await repositoryTopology(context.workspacePath, context.signal, execution) : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown }).code === "git_probe_failed"
          ? "git_probe_failed" : "repository_probe_failed";
        return result(request, startedAt, message, false, [code]);
      }
      if (!topology) {
        return result(request, startedAt, "Workspace is not a self-contained Git repository.", false, ["workspace_not_git_root"]);
      }
      if (!topology.worktreeRoot) {
        return result(request, startedAt, "This operation requires a Git worktree.", false, ["repository_bare"]);
      }
      if (topology.trust === "external_untrusted") {
        return result(
          request,
          startedAt,
          `Git metadata is outside the trusted workspace: ${topology.commonDir}`,
          false,
          ["external_read_required"]
        );
      }
      const repositoryRoot = topology.worktreeRoot;
      const output = await runProcess({
        execution: execution!,
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

export function repositoryTools(
  execution?: ProcessExecutionPort,
  providers: RepositoryToolProviders = {}
): RegisteredEffectTool[] {
  return [
    ...(providers.list ? [listTool(providers.list)] : []),
    ...(providers.statistics ? [repositoryStatsTool(providers.statistics)] : []),
    ...(providers.textSearch ? [grepTool(providers.textSearch)] : []),
    gitReadTool("git_status", ["status", "--short", "--branch"], "Show the repository branch and working-tree status without changing it.", execution),
    gitReadTool("git_diff", ["diff", "--no-ext-diff", "--stat", "--patch"], "Show the current unstaged Git diff without changing it.", execution)
  ];
}
