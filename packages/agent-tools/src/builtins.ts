import { realpath } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import { resolveWorkspacePath, runtimeEnvironment } from "agent-platform";
import type { ExecutionBroker } from "agent-execution";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";
import {
  repositoryTools,
  type RepositoryListProvider,
  type RepositoryStatisticsProvider,
  type RepositoryTextSearchProvider
} from "./repository-tools.js";
import { registerCompletionTool } from "./completion-tool.js";
import {
  applyUnifiedPatch,
  parseUnifiedPatch,
  replaceWorkspaceTextFile
} from "./atomic-patch.js";
import { registerControlTools } from "./control-tools.js";
import {
  executionTools,
  unavailableExecutionBroker,
  type ExecutionToolOptions
} from "./execution-tools.js";
import { codeIntelTool, type CodeIntelToolOptions } from "./lsp-tools.js";
import { deleteWorkspaceFile } from "./delete-file.js";
import {
  MAX_EXPLICIT_WORKSPACE_READ_BYTES,
  readStableWorkspaceTextFile
} from "./stable-workspace-read.js";

function args(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArg(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  return value;
}

async function writableTarget(workspacePath: string, requestedPath: string): Promise<string> {
  const workspace = await realpath(workspacePath);
  const target = await resolveWorkspacePath(workspacePath, requestedPath);
  const segments = path.relative(workspace, target).split(path.sep).filter(Boolean);
  if (segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === ".git" || normalized === ".agent";
  })) {
    throw Object.assign(new Error(`Protected workspace metadata is read-only: ${requestedPath}`), {
      code: "protected_path"
    });
  }
  return target;
}

class EditPreconditionError extends Error {}

function descriptor(input: Omit<ToolDescriptor, "inputSchema"> & { properties: Record<string, JsonValue>; required?: string[] }): ToolDescriptor {
  return {
    ...input,
    inputSchema: {
      type: "object",
      properties: input.properties,
      ...(input.required ? { required: input.required } : {}),
      additionalProperties: false
    }
  };
}

function receipt(
  request: ToolRequest,
  startedAt: string,
  input: Partial<Omit<ToolReceipt, "callId" | "startedAt" | "completedAt">>
): ToolReceipt {
  return {
    callId: request.callId,
    ok: input.ok ?? true,
    output: input.output ?? "",
    observedEffects: input.observedEffects ?? [],
    actualEffects: input.actualEffects ?? input.observedEffects ?? [],
    workspaceDelta: input.workspaceDelta,
    artifacts: input.artifacts ?? [],
    diagnostics: input.diagnostics ?? [],
    evidence: input.evidence ?? [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function readTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "read",
      description: `Read a UTF-8 text file inside the workspace (maximum ${MAX_EXPLICIT_WORKSPACE_READ_BYTES} bytes).`,
      properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      required: ["path"],
      possibleEffects: ["filesystem.read"],
      executionMode: "parallel",
      resourceKeys: [],
      contextPathArguments: ["path"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const content = await readStableWorkspaceTextFile(
        context.workspacePath,
        stringArg(input, "path"),
        context.signal
      );
      const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : 500;
      const lines = content.split(/\r?\n/).slice(offset, offset + limit);
      return receipt(request, startedAt, { output: lines.map((line, index) => `${offset + index + 1}: ${line}`).join("\n"), observedEffects: ["filesystem.read"] });
    }
  };
}

function writeTool(atomicPatchStateRootDir?: string): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "write",
      description: "Write a complete UTF-8 file inside the workspace.",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      possibleEffects: ["filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: true,
      timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      await writableTarget(context.workspacePath, relative);
      const result = await replaceWorkspaceTextFile(context.workspacePath, relative, {
        ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {}),
        transform: () => stringArg(input, "content")
      });
      return receipt(request, startedAt, {
        output: `Wrote ${relative}`,
        observedEffects: ["filesystem.write"],
        workspaceDelta: result.delta,
        diagnostics: result.cleanupWarning ? ["atomic_cleanup_pending"] : []
      });
    }
  };
}

function editTool(atomicPatchStateRootDir?: string): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "edit",
      description: "Replace one exact text occurrence in a workspace file.",
      properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
      required: ["path", "oldText", "newText"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      await writableTarget(context.workspacePath, relative);
      const oldText = stringArg(input, "oldText");
      let result: Awaited<ReturnType<typeof replaceWorkspaceTextFile>>;
      try {
        result = await replaceWorkspaceTextFile(context.workspacePath, relative, {
          ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {}),
          requireExisting: true,
          transform: (content) => {
            const first = content.indexOf(oldText);
            if (first < 0) throw new EditPreconditionError("oldText was not found");
            if (content.indexOf(oldText, first + oldText.length) >= 0) {
              throw new EditPreconditionError("oldText is not unique");
            }
            return `${content.slice(0, first)}${stringArg(input, "newText")}${content.slice(first + oldText.length)}`;
          }
        });
      } catch (error) {
        if (error instanceof EditPreconditionError) {
          return receipt(request, startedAt, {
            ok: false,
            output: error.message,
            observedEffects: ["filesystem.read"]
          });
        }
        throw error;
      }
      return receipt(request, startedAt, {
        output: `Edited ${relative}`,
        observedEffects: ["filesystem.read", "filesystem.write"],
        workspaceDelta: result.delta,
        diagnostics: result.cleanupWarning ? ["atomic_cleanup_pending"] : []
      });
    }
  };
}

function deleteFileTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "delete_file",
      description: "Delete exactly one regular file inside the workspace. Directories, recursive deletion, links, junctions, and .git/.agent metadata are rejected.",
      properties: { path: { type: "string" } },
      required: ["path"],
      possibleEffects: ["filesystem.read", "filesystem.write", "destructive"],
      availableModes: ["change"],
      maximumEffects: ["filesystem.read", "filesystem.write", "destructive"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const requestedPath = stringArg(input, "path");
      const relativePath = await deleteWorkspaceFile(context.workspacePath, requestedPath, context.signal);
      return receipt(request, startedAt, {
        output: `Deleted ${relativePath}`,
        observedEffects: ["filesystem.read", "filesystem.write", "destructive"],
        workspaceDelta: { added: [], modified: [], deleted: [relativePath] }
      });
    }
  };
}

function applyPatchTool(atomicPatchStateRootDir?: string): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "apply_patch",
      description: "Atomically apply a unified multi-file patch inside the workspace. All hunks are preflighted; any failure leaves every file unchanged.",
      properties: {
        patch: { type: "string" },
        preimageHashes: { type: "object", additionalProperties: { type: "string" } }
      },
      required: ["patch"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      availableModes: ["change"],
      maximumEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 120_000,
      prepare(argumentsValue) {
        const input = args(argumentsValue);
        const files = parseUnifiedPatch(stringArg(input, "patch"));
        const paths = [...new Set(files.flatMap((item) => [item.oldPath, item.newPath]
          .filter((value): value is string => Boolean(value))))];
        return {
          exactEffects: ["filesystem.read", "filesystem.write"],
          readPaths: paths,
          writePaths: paths,
          network: "none",
          processMode: "none",
          checkpointScope: paths,
          idempotence: "non_replayable"
        };
      }
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const rawHashes = input.preimageHashes;
      const preimageHashes = rawHashes && typeof rawHashes === "object" && !Array.isArray(rawHashes)
        ? Object.fromEntries(Object.entries(rawHashes).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;
      const result = await applyUnifiedPatch(context.workspacePath, stringArg(input, "patch"), {
        ...(preimageHashes ? { preimageHashes } : {}),
        ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {})
      });
      const completedAt = new Date().toISOString();
      return {
        callId: request.callId,
        ok: true,
        output: JSON.stringify(result),
        observedEffects: ["filesystem.read", "filesystem.write"],
        actualEffects: ["filesystem.read", "filesystem.write"],
        workspaceDelta: result.delta,
        artifacts: [],
        diagnostics: [],
        // The checkpoint manager emits the authoritative delta after sealing.
        evidence: [],
        startedAt,
        completedAt
      };
    }
  };
}

export interface BuiltinToolOptions extends Partial<Omit<ExecutionToolOptions, "broker">> {
  broker?: ExecutionBroker;
  codeIntel?: Omit<CodeIntelToolOptions, "broker">;
  repositoryList?: RepositoryListProvider;
  repositoryStatistics?: RepositoryStatisticsProvider;
  repositoryTextSearch?: RepositoryTextSearchProvider;
  /** Durable external root used for atomic write/edit/apply_patch recovery. */
  atomicPatchStateRootDir?: string;
}

export function registerBuiltinTools(registry: EffectToolRegistry, options: BuiltinToolOptions = {}): EffectToolRegistry {
  const defaultShell = runtimeEnvironment().defaultShell;
  const execution: ExecutionToolOptions = {
    broker: options.broker ?? unavailableExecutionBroker(),
    sandboxMode: options.sandboxMode ?? "required",
    networkMode: options.networkMode ?? "none",
    shells: options.shells ?? (defaultShell === "none" ? [] : [defaultShell]),
    runtimeCommands: options.runtimeCommands ?? [],
    foreground: options.foreground ?? true,
    background: options.background ?? true,
    stdin: options.stdin ?? true,
    pty: options.pty ?? true,
    networkModes: options.networkModes ?? ["none", "full"]
  };
  const codeIntel = options.codeIntel ? [codeIntelTool({ broker: execution.broker, ...options.codeIntel })] : [];
  for (const tool of [
    readTool(), writeTool(options.atomicPatchStateRootDir), editTool(options.atomicPatchStateRootDir),
    deleteFileTool(), applyPatchTool(options.atomicPatchStateRootDir),
    ...codeIntel, ...executionTools(execution),
    ...repositoryTools(options.broker, {
      list: options.repositoryList,
      statistics: options.repositoryStatistics,
      textSearch: options.repositoryTextSearch
    })
  ]) registry.register(tool);
  return registerControlTools(registerCompletionTool(registry));
}
