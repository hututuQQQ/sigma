import type { EvidenceRecord, ToolResult, WorkflowPhase, WorkflowStateSummary } from "../types.js";

export interface WorkflowState {
  phase: WorkflowPhase;
  commandsTried: string[];
  evidenceRecords: EvidenceRecord[];
}

export function createWorkflowState(): WorkflowState {
  return {
    phase: "triage",
    commandsTried: [],
    evidenceRecords: []
  };
}

function commandFromArgs(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (toolName === "bash" && typeof record.command === "string") return record.command;
  if (toolName === "service" && typeof record.command === "string") return record.command;
  if (toolName === "shell_session" && typeof record.input === "string") return record.input;
  return null;
}

export function recordToolInWorkflow(options: {
  workflow: WorkflowState;
  toolName: string;
  args: unknown;
  result: ToolResult;
  evidence?: EvidenceRecord | null;
}): void {
  const command = commandFromArgs(options.toolName, options.args);
  if (command) options.workflow.commandsTried.push(command);
  if (options.evidence) options.workflow.evidenceRecords.push(options.evidence);

  if (options.evidence?.executable) {
    options.workflow.phase = "verify";
    return;
  }
  if (options.toolName === "write" || options.toolName === "edit" || options.toolName === "apply_patch") {
    options.workflow.phase = "implement";
    return;
  }
  if (options.toolName === "todo") {
    options.workflow.phase = "plan";
    return;
  }
  if (options.toolName === "bash" || options.toolName === "service" || options.toolName === "shell_session") {
    options.workflow.phase = options.result.ok ? "explore" : "repair";
    return;
  }
  if (options.result.ok) options.workflow.phase = "explore";
}

export function summarizeWorkflowState(workflow: WorkflowState, changedFiles: string[]): WorkflowStateSummary {
  return {
    phase: workflow.phase,
    commands_tried: workflow.commandsTried.slice(-30),
    changed_files: changedFiles
  };
}
