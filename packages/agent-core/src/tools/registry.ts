import type { ToolCall } from "agent-ai";
import type {
  RegisteredTool,
  ToolExecutionContext,
  ToolRegistry,
  ToolRegistryFilter,
  ToolRegistryOptions,
  ToolResult,
  WorkspaceManifest
} from "../types.js";
import {
  lowerToolDescriptorForModel,
  normalizeToolResult,
  toolAllMetadata,
  toolDescriptorFromDefinition
} from "../types.js";
import { executeBashTool } from "./bash.js";
import { executeReadTool, executeReadManyTool } from "./read.js";
import { executeWriteTool } from "./write.js";
import { executeEditTool } from "./edit.js";
import { executeServiceTool } from "./service.js";
import { executeListTool } from "./list.js";
import { executeGlobTool } from "./glob.js";
import { executeGrepTool } from "./grep.js";
import { executeGitStatusTool, executeGitDiffTool } from "./git.js";
import { executeApplyPatchTool } from "./apply-patch.js";
import { executeTodoTool } from "./todo.js";
import { executeRepoQueryTool } from "./repo-query.js";
import { executeSymbolSearchTool } from "./symbol-search.js";
import { executeValidateTool } from "./validate.js";
import { executeMemoryTool } from "./memory.js";
import { createShellSessionToolController } from "./shell-session.js";
import { invalidateContextIndexes } from "../context/code-index.js";
import { changedWorkspaceFiles, listWorkspaceManifest } from "../harness/manifest.js";
import { isToolDeniedByPermissionRules } from "../policy.js";
import { READ_ONLY_SUBAGENT_TOOLS } from "../subagents/subagent-runner.js";
import { createSubagentJobTool, createSubtaskTool } from "../subagents/subtask-tool.js";
import type { SubagentType } from "../types.js";
import { DEFAULT_SUBAGENTS_ENABLED } from "../defaults.js";

const FILE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch", "bash", "shell_session", "service"]);

function readonlyRuntime(): RegisteredTool["runtime"] {
  return { readOnly: true, supportsParallel: true, approval: "auto", sandbox: "bypass" };
}

function serialRuntime(): RegisteredTool["runtime"] {
  return { readOnly: false, supportsParallel: false, approval: "prompt", sandbox: "default" };
}

function resultChangedFiles(result: ToolResult): string[] {
  const metadata = toolAllMetadata(result);
  if (metadata.checkOnly === true) return [];
  const changedFiles = metadata.changedFiles;
  if (Array.isArray(changedFiles)) return changedFiles.filter((file): file is string => typeof file === "string" && file.length > 0);
  if (typeof metadata.relativePath === "string" && metadata.relativePath.length > 0) return [metadata.relativePath];
  return [];
}

function normalizeRegisteredTool(tool: RegisteredTool): RegisteredTool {
  const descriptor = tool.descriptor ?? toolDescriptorFromDefinition(tool.definition, {
    risk: tool.risk,
    runtime: tool.runtime
  });
  return {
    ...tool,
    descriptor,
    definition: lowerToolDescriptorForModel(descriptor),
    runtime: {
      ...descriptor.runtime,
      ...tool.runtime
    }
  };
}

function contextIndexCacheActive(context: ToolExecutionContext): boolean {
  return (context.runState.contextIndexes?.size ?? 0) > 0;
}

async function safeWorkspaceManifest(context: ToolExecutionContext): Promise<WorkspaceManifest | null> {
  try {
    return await listWorkspaceManifest(context.workspacePath);
  } catch {
    return null;
  }
}

function manifestChangedFiles(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
  const changed = new Set(changedWorkspaceFiles(before, after));
  for (const filePath of Object.keys(before)) {
    if (!after[filePath]) changed.add(filePath);
  }
  return [...changed].sort((a, b) => a.localeCompare(b, "en"));
}

async function executeWithContextIndexInvalidation(
  tool: RegisteredTool,
  toolCall: ToolCall,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const toolName = toolCall.function.name;
  const shouldWatchManifest = FILE_MUTATING_TOOLS.has(toolName) && contextIndexCacheActive(context);
  const beforeManifest = shouldWatchManifest ? await safeWorkspaceManifest(context) : null;
  const result = await tool.execute(toolCall.function.arguments, context);
  if (!result.ok || !FILE_MUTATING_TOOLS.has(toolName)) return result;

  const changedFiles = resultChangedFiles(result);
  const manifestChanges = beforeManifest
    ? manifestChangedFiles(beforeManifest, await safeWorkspaceManifest(context) ?? beforeManifest)
    : [];
  if (changedFiles.length > 0 || manifestChanges.length > 0) {
    invalidateContextIndexes(context);
  }
  return result;
}

const bashTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command with bash -lc inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutSec: { type: "number" }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  execute: executeBashTool,
  risk: "execute",
  runtime: serialRuntime()
};

const readTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file from the workspace. Binary files return metadata only.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  execute: executeReadTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const readManyTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "read_many",
      description: "Read multiple workspace files or snippets in one call. Binary files return metadata only.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    offset: { type: "number" },
                    limit: { type: "number" }
                  },
                  required: ["path"],
                  additionalProperties: false
                }
              ]
            }
          },
          maxCharsPerFile: { type: "number" }
        },
        required: ["files"],
        additionalProperties: false
      }
    }
  },
  execute: executeReadManyTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const writeTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "write",
      description: "Write a UTF-8 file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createDirs: { type: "boolean" }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  execute: executeWriteTool,
  risk: "write",
  runtime: serialRuntime()
};

const editTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "edit",
      description: "Replace exact text in a UTF-8 file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          expectedReplacements: { type: "number" }
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false
      }
    }
  },
  execute: executeEditTool,
  risk: "write",
  runtime: serialRuntime()
};

const serviceTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "service",
      description:
        "Manage long-running background services. Use service.start for servers instead of bare '&', nohup, or setsid in bash. Services with a port or readinessCommand stay available after the run by default; set keepAliveAfterRun=false only for temporary helpers.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "status", "logs", "stop"] },
          name: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          port: { type: "number" },
          readinessCommand: { type: "string" },
          logPath: { type: "string" },
          keepAliveAfterRun: { type: "boolean" },
          readinessTimeoutSec: { type: "number" },
          maxLogChars: { type: "number" }
        },
        required: ["action"],
        additionalProperties: false
      }
    }
  },
  execute: executeServiceTool,
  risk: "execute",
  runtime: serialRuntime()
};

const listTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "list",
      description: "List workspace files and directories safely with bounded depth.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          depth: { type: "number" },
          includeHidden: { type: "boolean" },
          maxEntries: { type: "number" }
        },
        additionalProperties: false
      }
    }
  },
  execute: executeListTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const globTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: "Find workspace files by simple glob patterns supporting *, **, and ?.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          cwd: { type: "string" },
          maxMatches: { type: "number" }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  execute: executeGlobTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const grepTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: "Search text files in the workspace and return matching snippets.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          caseSensitive: { type: "boolean" },
          contextLines: { type: "number" },
          maxMatches: { type: "number" }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  execute: executeGrepTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const repoQueryTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "repo_query",
      description:
        "Search the workspace with lexical, symbol, and path signals and return compact scored file snippets. Useful for finding symbols, tests, configs, or paths.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["text", "symbol", "test", "config", "path"] },
          path: { type: "string" },
          maxSnippets: { type: "number" },
          maxChars: { type: "number" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  execute: executeRepoQueryTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const symbolSearchTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "symbol_search",
      description:
        "Search declared functions, classes, interfaces, types, constants, and tests using Sigma's lightweight local code index.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["function", "class", "interface", "type", "const", "method", "test", "unknown"] },
          path: { type: "string" },
          maxResults: { type: "number" },
          maxChars: { type: "number" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  execute: executeSymbolSearchTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const validateTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "validate",
      description:
        "Run an in-loop validation command or infer a project validation command for changed files, a file, or the whole project.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["auto", "test", "lint", "typecheck", "build"] },
          scope: { type: "string", enum: ["changed", "project", "file"] },
          path: { type: "string" },
          command: { type: "string" },
          timeoutSec: { type: "number" }
        },
        additionalProperties: false
      }
    }
  },
  execute: executeValidateTool,
  risk: "execute",
  runtime: serialRuntime()
};

function createShellSessionTool(): RegisteredTool & { registryClose: ToolRegistry["close"] } {
  const controller = createShellSessionToolController();
  return {
    definition: {
      type: "function",
      function: {
        name: "shell_session",
        description:
          "Manage a persistent non-PTY bash session for multi-step terminal workflows. Use action start, send, read, stop, or list.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "send", "read", "stop", "list"] },
            sessionId: { type: "string" },
            cwd: { type: "string" },
            input: { type: "string" },
            timeoutSec: { type: "number" },
            maxOutputChars: { type: "number" }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    },
    execute: controller.execute,
    risk: "execute",
    runtime: serialRuntime(),
    registryClose: controller.close
  };
}

const gitStatusTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "git_status",
      description: "Show git status for the workspace without modifying files.",
      parameters: {
        type: "object",
        properties: {
          porcelain: { type: "boolean" },
          maxOutputChars: { type: "number" }
        },
        additionalProperties: false
      }
    }
  },
  execute: executeGitStatusTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const gitDiffTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff for the workspace or one workspace-contained path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          staged: { type: "boolean" },
          maxOutputChars: { type: "number" }
        },
        additionalProperties: false
      }
    }
  },
  execute: executeGitDiffTool,
  risk: "read",
  runtime: readonlyRuntime()
};

const applyPatchTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a safe unified diff patch to workspace-relative files.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string" },
          expectedFiles: { type: "array", items: { type: "string" } },
          checkOnly: { type: "boolean" }
        },
        required: ["patch"],
        additionalProperties: false
      }
    }
  },
  execute: executeApplyPatchTool,
  risk: "write",
  runtime: serialRuntime()
};

const todoTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "todo",
      description: "Maintain a run-scoped task scratchpad for the agent.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "set", "add", "update", "clear"] },
          items: { type: "array" },
          text: { type: "string" },
          id: { oneOf: [{ type: "string" }, { type: "number" }] },
          status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
          note: { type: "string" }
        },
        required: ["action"],
        additionalProperties: false
      }
    }
  },
  execute: executeTodoTool,
  risk: "read",
  runtime: { readOnly: false, supportsParallel: false, approval: "auto", sandbox: "bypass" }
};

const memoryTool: RegisteredTool = {
  definition: {
    type: "function",
    function: {
      name: "memory",
      description:
        "List, read, search, or write durable local memories in .agent/memory. Store user preferences, feedback, project notes, or reference notes; do not store code facts that can be derived from current files.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read", "search", "write"] },
          id: { type: "string" },
          kind: { type: "string", enum: ["user", "feedback", "project", "reference", "agent", "subagent"] },
          scopes: { type: "array", items: { type: "string", enum: ["user", "feedback", "project", "reference", "agent", "subagent"] } },
          title: { type: "string" },
          content: { type: "string" },
          query: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
          maxChars: { type: "number" }
        },
        required: ["action"],
        additionalProperties: false
      }
    }
  },
  execute: executeMemoryTool,
  risk: "write",
  runtime: { readOnly: false, supportsParallel: false, approval: "auto", sandbox: "bypass" },
  descriptor: undefined
};

export function createToolRegistryFromTools(
  registeredTools: RegisteredTool[],
  options: ToolRegistryOptions = {}
): ToolRegistry {
  const toolMap = new Map<string, RegisteredTool>();
  for (const rawTool of registeredTools) {
    const tool = normalizeRegisteredTool(rawTool);
    const name = tool.definition.function.name;
    if (toolMap.has(name) && options.allowOverrides !== true) {
      throw new Error(`Duplicate tool name: ${name}`);
    }
    toolMap.set(name, tool);
  }

  return {
    descriptors: Array.from(toolMap.values(), (tool) => tool.descriptor ?? toolDescriptorFromDefinition(tool.definition, { risk: tool.risk, runtime: tool.runtime })),
    definitions: Array.from(toolMap.values(), (tool) => tool.definition),
    getTool(name: string): RegisteredTool | undefined {
      return toolMap.get(name);
    },
    getDescriptor(name: string) {
      return toolMap.get(name)?.descriptor;
    },
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      const tool = toolMap.get(toolCall.function.name);
      if (!tool) {
        return { ok: false, modelContent: `Unknown tool: ${toolCall.function.name}` };
      }
      return normalizeToolResult(await executeWithContextIndexInvalidation(tool, toolCall, context));
    },
    async close(): Promise<void> {
      const closers = new Set<ToolRegistry["close"]>();
      for (const tool of toolMap.values()) {
        const registry = (tool as RegisteredTool & { registryClose?: ToolRegistry["close"] }).registryClose;
        if (registry) closers.add(registry);
      }
      await Promise.all([...closers].map((close) => close?.()));
    }
  };
}

function createReadOnlySubagentRegistry(_subagentType: SubagentType): ToolRegistry {
  const readOnlyTools = [
    readTool,
    listTool,
    globTool,
    grepTool,
    repoQueryTool,
    symbolSearchTool,
    gitStatusTool,
    gitDiffTool
  ];
  const allowed = new Set<string>(READ_ONLY_SUBAGENT_TOOLS);
  return createToolRegistryFromTools(readOnlyTools.filter((tool) => allowed.has(tool.definition.function.name)));
}

export function createDefaultToolRegistry(_options: ToolRegistryOptions = {}): ToolRegistry {
  const subagentTools = (_options.subagents?.enabled ?? DEFAULT_SUBAGENTS_ENABLED) === true
    ? [
        createSubtaskTool({
          toolName: "task",
          createToolRegistry: createReadOnlySubagentRegistry,
          defaultMaxTurns: _options.subagents?.defaultMaxTurns,
          defaultMaxOutputChars: _options.subagents?.defaultMaxOutputChars,
          backgroundEnabled: _options.subagents?.backgroundEnabled,
          heartbeatTimeoutSec: _options.subagents?.heartbeatTimeoutSec
        }),
        createSubtaskTool({
          toolName: "subtask",
          createToolRegistry: createReadOnlySubagentRegistry,
          defaultMaxTurns: _options.subagents?.defaultMaxTurns,
          defaultMaxOutputChars: _options.subagents?.defaultMaxOutputChars,
          backgroundEnabled: _options.subagents?.backgroundEnabled,
          heartbeatTimeoutSec: _options.subagents?.heartbeatTimeoutSec
        }),
        createSubagentJobTool()
      ]
    : [];
  return createToolRegistryFromTools(
    [
      bashTool,
      serviceTool,
      readTool,
      readManyTool,
      writeTool,
      editTool,
      listTool,
      globTool,
      grepTool,
      repoQueryTool,
      symbolSearchTool,
      gitStatusTool,
      gitDiffTool,
      applyPatchTool,
      validateTool,
      todoTool,
      memoryTool,
      ...subagentTools,
      createShellSessionTool()
    ],
    _options
  );
}

export function mergeToolRegistries(registries: ToolRegistry[], options: ToolRegistryOptions = {}): ToolRegistry {
  const definitionsByName = new Map<string, { registry: ToolRegistry; definition: ToolRegistry["definitions"][number]; descriptor: RegisteredTool["descriptor"] }>();
  for (const registry of registries) {
    for (const definition of registry.definitions) {
      const name = definition.function.name;
      if (definitionsByName.has(name) && options.allowOverrides !== true) {
        throw new Error(`Duplicate tool name: ${name}`);
      }
      definitionsByName.set(name, { registry, definition, descriptor: registry.getDescriptor?.(name) ?? registry.getTool?.(name)?.descriptor });
    }
  }
  return {
    descriptors: [...definitionsByName.values()].map((entry) => entry.descriptor ?? toolDescriptorFromDefinition(entry.definition)),
    definitions: [...definitionsByName.values()].map((entry) => entry.definition),
    getTool(name: string): RegisteredTool | undefined {
      const entry = definitionsByName.get(name);
      return entry?.registry.getTool?.(name);
    },
    getDescriptor(name: string) {
      return definitionsByName.get(name)?.descriptor;
    },
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      const entry = definitionsByName.get(toolCall.function.name);
      if (!entry) return { ok: false, modelContent: `Unknown tool: ${toolCall.function.name}` };
      return normalizeToolResult(await entry.registry.execute(toolCall, context));
    },
    async close(): Promise<void> {
      await Promise.all(registries.map((registry) => registry.close?.()));
    }
  };
}

export function filterToolRegistry(registry: ToolRegistry, filter: ToolRegistryFilter): ToolRegistry {
  const allowed = filter.allowedTools && filter.allowedTools.length > 0 ? new Set(filter.allowedTools) : null;
  const disabled = new Set(filter.disabledTools ?? []);
  const deniedByPermission = new Set(
    registry.definitions
      .map((definition) => definition.function.name)
      .filter((name) => {
        const tool = registry.getTool?.(name);
        return tool ? isToolDeniedByPermissionRules(tool, filter.permissionRules) : false;
      })
  );
  const names = new Set(
    registry.definitions
      .map((definition) => definition.function.name)
      .filter((name) => (allowed ? allowed.has(name) : true))
      .filter((name) => !disabled.has(name))
      .filter((name) => !deniedByPermission.has(name))
  );
  return {
    descriptors: (registry.descriptors ?? registry.definitions.map((definition) => toolDescriptorFromDefinition(definition)))
      .filter((descriptor) => names.has(descriptor.model.function.name)),
    definitions: registry.definitions.filter((definition) => names.has(definition.function.name)),
    getTool(name: string): RegisteredTool | undefined {
      return names.has(name) ? registry.getTool?.(name) : undefined;
    },
    getDescriptor(name: string) {
      return names.has(name) ? registry.getDescriptor?.(name) : undefined;
    },
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      if (!names.has(toolCall.function.name)) {
        return { ok: false, modelContent: `Unknown or disabled tool: ${toolCall.function.name}` };
      }
      return normalizeToolResult(await registry.execute(toolCall, context));
    },
    async close(): Promise<void> {
      await registry.close?.();
    }
  };
}
