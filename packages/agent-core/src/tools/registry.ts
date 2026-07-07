import type { ToolCall } from "agent-ai";
import type {
  RegisteredTool,
  ToolExecutionContext,
  ToolRegistry,
  ToolRegistryFilter,
  ToolRegistryOptions,
  ToolResult
} from "../types.js";
import { executeBashTool } from "./bash.js";
import { executeReadTool } from "./read.js";
import { executeWriteTool } from "./write.js";
import { executeEditTool } from "./edit.js";
import { executeServiceTool } from "./service.js";
import { executeListTool } from "./list.js";
import { executeGlobTool } from "./glob.js";
import { executeGrepTool } from "./grep.js";
import { executeGitStatusTool, executeGitDiffTool } from "./git.js";
import { executeApplyPatchTool } from "./apply-patch.js";
import { executeTodoTool } from "./todo.js";

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
  risk: "execute"
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
  risk: "read"
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
  risk: "write"
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
  risk: "write"
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
  risk: "execute"
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
  risk: "read"
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
  risk: "read"
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
  risk: "read"
};

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
  risk: "read"
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
  risk: "read"
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
  risk: "write"
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
  risk: "read"
};

export function createToolRegistryFromTools(
  registeredTools: RegisteredTool[],
  options: ToolRegistryOptions = {}
): ToolRegistry {
  const toolMap = new Map<string, RegisteredTool>();
  for (const tool of registeredTools) {
    const name = tool.definition.function.name;
    if (toolMap.has(name) && options.allowOverrides !== true) {
      throw new Error(`Duplicate tool name: ${name}`);
    }
    toolMap.set(name, tool);
  }

  return {
    definitions: Array.from(toolMap.values(), (tool) => tool.definition),
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      const tool = toolMap.get(toolCall.function.name);
      if (!tool) {
        return { ok: false, content: `Unknown tool: ${toolCall.function.name}` };
      }
      return await tool.execute(toolCall.function.arguments, context);
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

export function createDefaultToolRegistry(_options: ToolRegistryOptions = {}): ToolRegistry {
  return createToolRegistryFromTools(
    [
      bashTool,
      serviceTool,
      readTool,
      writeTool,
      editTool,
      listTool,
      globTool,
      grepTool,
      gitStatusTool,
      gitDiffTool,
      applyPatchTool,
      todoTool
    ],
    _options
  );
}

export function mergeToolRegistries(registries: ToolRegistry[], options: ToolRegistryOptions = {}): ToolRegistry {
  const definitionsByName = new Map<string, { registry: ToolRegistry; definition: ToolRegistry["definitions"][number] }>();
  for (const registry of registries) {
    for (const definition of registry.definitions) {
      const name = definition.function.name;
      if (definitionsByName.has(name) && options.allowOverrides !== true) {
        throw new Error(`Duplicate tool name: ${name}`);
      }
      definitionsByName.set(name, { registry, definition });
    }
  }
  return {
    definitions: [...definitionsByName.values()].map((entry) => entry.definition),
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      const entry = definitionsByName.get(toolCall.function.name);
      if (!entry) return { ok: false, content: `Unknown tool: ${toolCall.function.name}` };
      return await entry.registry.execute(toolCall, context);
    },
    async close(): Promise<void> {
      await Promise.all(registries.map((registry) => registry.close?.()));
    }
  };
}

export function filterToolRegistry(registry: ToolRegistry, filter: ToolRegistryFilter): ToolRegistry {
  const allowed = filter.allowedTools && filter.allowedTools.length > 0 ? new Set(filter.allowedTools) : null;
  const disabled = new Set(filter.disabledTools ?? []);
  const names = new Set(
    registry.definitions
      .map((definition) => definition.function.name)
      .filter((name) => (allowed ? allowed.has(name) : true))
      .filter((name) => !disabled.has(name))
  );
  return {
    definitions: registry.definitions.filter((definition) => names.has(definition.function.name)),
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      if (!names.has(toolCall.function.name)) {
        return { ok: false, content: `Unknown or disabled tool: ${toolCall.function.name}` };
      }
      return await registry.execute(toolCall, context);
    },
    async close(): Promise<void> {
      await registry.close?.();
    }
  };
}
