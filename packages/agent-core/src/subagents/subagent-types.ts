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
  background?: boolean;
}

export interface SubagentRunnerOptions {
  createToolRegistry: (subagentType: SubagentType) => ToolRegistry;
  defaultMaxTurns?: number;
  defaultMaxOutputChars?: number;
  backgroundEnabled?: boolean;
  heartbeatTimeoutSec?: number;
}

export interface SubagentToolOptions extends SubagentRunnerOptions {
  toolName?: "task" | "subtask";
}

export interface SubagentExecution {
  request: SubagentRunRequest;
  context: ToolExecutionContext;
  options: SubagentRunnerOptions;
}

export type SubagentJobStatus = "running" | "completed" | "error" | "interrupted" | "closed";

export interface SubagentJobSummary {
  job_id: string;
  status: SubagentJobStatus;
  subagent_type: SubagentType;
  description: string;
  background: true;
  created_at: string;
  updated_at: string;
  report?: SubagentRunSummary;
  error?: string;
}

export interface SubagentJobManager {
  create(request: SubagentRunRequest, context: ToolExecutionContext, options: SubagentRunnerOptions): SubagentJobSummary;
  list(): SubagentJobSummary[];
  wait(jobId: string, timeoutMs?: number): Promise<SubagentJobSummary | null>;
  followup(jobId: string, prompt: string): Promise<SubagentJobSummary>;
  interrupt(jobId: string, reason?: string): Promise<SubagentJobSummary>;
  close(jobId?: string): Promise<SubagentJobSummary[]>;
}
