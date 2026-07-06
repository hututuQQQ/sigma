import type { ToolCall } from "agent-ai";
import type { RegisteredTool, ToolExecutionContext, ToolRegistry, ToolResult } from "../types.js";
import { executeBashTool } from "./bash.js";
import { executeReadTool } from "./read.js";
import { executeWriteTool } from "./write.js";
import { executeEditTool } from "./edit.js";

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
  execute: executeBashTool
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
  execute: executeReadTool
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
  execute: executeWriteTool
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
  execute: executeEditTool
};

export function createDefaultToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  for (const tool of [bashTool, readTool, writeTool, editTool]) {
    tools.set(tool.definition.function.name, tool);
  }

  return {
    definitions: Array.from(tools.values(), (tool) => tool.definition),
    async execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
      const tool = tools.get(toolCall.function.name);
      if (!tool) {
        return { ok: false, content: `Unknown tool: ${toolCall.function.name}` };
      }
      return await tool.execute(toolCall.function.arguments, context);
    }
  };
}
