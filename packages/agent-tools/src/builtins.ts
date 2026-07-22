import type { ExecutionBroker } from "agent-execution";
import { runtimeEnvironment } from "agent-platform";
import { applyUnifiedPatch, parseUnifiedPatch } from "./atomic-patch.js";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import { registerCompletionTool } from "./completion-tool.js";
import { registerControlTools } from "./control-tools.js";
import { deleteWorkspaceFile } from "./delete-file.js";
import {
  executionTools,
  unavailableExecutionBroker,
  type ExecutionToolOptions
} from "./execution-tools.js";
import { codeIntelTool, type CodeIntelToolOptions } from "./lsp-tools.js";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";
import {
  repositoryTools,
  type RepositoryListProvider,
  type RepositoryStatisticsProvider,
  type RepositoryTextSearchProvider
} from "./repository-tools.js";
import { workspaceTextTools } from "./workspace-text-tools.js";
import { environmentPrepareTool } from "./managed-environment-tool.js";

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
        ? Object.fromEntries(Object.entries(rawHashes)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
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

function builtinExecutionOptions(options: BuiltinToolOptions): ExecutionToolOptions {
  const defaultShell = runtimeEnvironment().defaultShell;
  return {
    broker: options.broker ?? unavailableExecutionBroker(),
    executionBackend: options.executionBackend,
    executionPlatform: options.executionPlatform,
    managedEnvironment: options.managedEnvironment,
    sandboxMode: options.sandboxMode ?? "required",
    readScope: options.readScope ?? "workspace",
    processHandoff: options.processHandoff ?? "allow",
    networkMode: options.networkMode ?? "none",
    // The platform-selected shell is a verified local runtime capability;
    // an explicitly connected broker may narrow it with options.shells.
    shells: options.shells ?? (defaultShell === "none" ? [] : [defaultShell]),
    runtimeCommands: options.runtimeCommands ?? [],
    foreground: options.foreground ?? true,
    background: options.background ?? true,
    stdin: options.stdin ?? true,
    pty: options.pty ?? true,
    handoff: options.processHandoff !== "deny" && options.handoff === true,
    networkModes: options.networkModes ?? ["none", "full"]
  };
}

export function registerBuiltinTools(
  registry: EffectToolRegistry,
  options: BuiltinToolOptions = {}
): EffectToolRegistry {
  const execution = builtinExecutionOptions(options);
  const codeIntel = options.codeIntel
    ? [codeIntelTool({ broker: execution.broker, ...options.codeIntel })]
    : [];
  const environmentPrepare = environmentPrepareTool(execution);
  for (const tool of [
    ...workspaceTextTools(options.atomicPatchStateRootDir, execution.readScope),
    deleteFileTool(),
    applyPatchTool(options.atomicPatchStateRootDir),
    ...codeIntel,
    ...executionTools(execution),
    ...(environmentPrepare ? [environmentPrepare] : []),
    ...repositoryTools(options.broker, {
      list: options.repositoryList,
      statistics: options.repositoryStatistics,
      textSearch: options.repositoryTextSearch
    })
  ]) registry.register(tool);
  return registerControlTools(registerCompletionTool(registry));
}
