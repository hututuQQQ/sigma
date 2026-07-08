import type { ToolRegistry } from "../types.js";
import type {
  SubagentFinding,
  SubagentRunSummary,
  SubagentType,
  ToolExecutionContext
} from "../types.js";

export type {
  SubagentFinding,
  SubagentRunSummary,
  SubagentType
} from "../types.js";

export interface SubagentRunRequest {
  description: string;
  prompt: string;
  subagentType: SubagentType;
  relatedFiles?: string[];
  maxTurns?: number;
  maxOutputChars?: number;
  background?: false;
}

export interface SubagentRunnerOptions {
  createToolRegistry: (subagentType: SubagentType) => ToolRegistry;
  defaultMaxTurns?: number;
  defaultMaxOutputChars?: number;
}

export interface SubagentToolOptions extends SubagentRunnerOptions {
  toolName?: "task" | "subtask";
}

export interface SubagentExecution {
  request: SubagentRunRequest;
  context: ToolExecutionContext;
  options: SubagentRunnerOptions;
}

