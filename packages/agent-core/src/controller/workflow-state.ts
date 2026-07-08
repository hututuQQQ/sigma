import { compactLargeCommand, truncateMiddle } from "../compaction.js";
import { analyzeFailure, failureInputFromToolResult, type FailureAnalysis } from "../workflow/failure-analyzer.js";
import type {
  EvidenceRecord,
  ToolResult,
  WorkflowFailureCategory,
  WorkflowFailurePatternSummary,
  WorkflowPhase,
  WorkflowStateSummary
} from "../types.js";

export interface WorkflowState {
  phase: WorkflowPhase;
  commandsTried: string[];
  evidenceRecords: EvidenceRecord[];
  failurePatterns: Map<WorkflowFailureCategory, WorkflowFailurePatternSummary>;
  nudgedFailureCategories: Set<WorkflowFailureCategory>;
}

export function createWorkflowState(): WorkflowState {
  return {
    phase: "triage",
    commandsTried: [],
    evidenceRecords: [],
    failurePatterns: new Map(),
    nudgedFailureCategories: new Set()
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

function compactSummary(text: string, maxChars = 300): string {
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), maxChars).text;
}

function recordFailurePattern(options: {
  workflow: WorkflowState;
  toolName: string;
  command: string | null;
  result: ToolResult;
  analysis: FailureAnalysis;
}): WorkflowFailurePatternSummary {
  const previous = options.workflow.failurePatterns.get(options.analysis.category);
  const record: WorkflowFailurePatternSummary = {
    category: options.analysis.category,
    count: (previous?.count ?? 0) + 1,
    last_tool_name: options.toolName,
    ...(options.command ? { last_command: compactLargeCommand(options.command, 1200).text } : {}),
    ...(options.analysis.exitCode !== undefined ? { last_exit_code: options.analysis.exitCode } : {}),
    last_summary: compactSummary(options.analysis.primaryMessage || options.result.content),
    suggested_next_action: options.analysis.suggestedNextAction,
    ...(options.analysis.diagnostics.length > 0 ? { diagnostics: options.analysis.diagnostics } : {})
  };
  options.workflow.failurePatterns.set(options.analysis.category, record);
  return record;
}

export function workflowFailureNudge(
  workflow: WorkflowState,
  failure: WorkflowFailurePatternSummary | null
): string | null {
  if (!failure) return null;
  if (workflow.nudgedFailureCategories.has(failure.category)) return null;
  workflow.nudgedFailureCategories.add(failure.category);
  const lines = [
    `Workflow repair signal: the last tool failure was categorized as ${failure.category}.`,
    failure.suggested_next_action ?? "Inspect the failure summary, make a focused repair, then rerun the relevant check."
  ];
  if (failure.last_command) lines.push(`Failing command summary: ${failure.last_command}`);
  lines.push(`Failure summary: ${failure.last_summary}`);
  return lines.join("\n");
}

export function recordToolInWorkflow(options: {
  workflow: WorkflowState;
  toolName: string;
  args: unknown;
  result: ToolResult;
  evidence?: EvidenceRecord | null;
}): WorkflowFailurePatternSummary | null {
  const command = commandFromArgs(options.toolName, options.args);
  if (command) options.workflow.commandsTried.push(compactLargeCommand(command, 1200).text);
  if (options.evidence) options.workflow.evidenceRecords.push(options.evidence);

  const failureAnalysis = analyzeFailure(failureInputFromToolResult({
    toolName: options.toolName,
    command,
    result: options.result
  }));
  if (failureAnalysis) {
    options.workflow.phase = "repair";
    return recordFailurePattern({
      workflow: options.workflow,
      toolName: options.toolName,
      command,
      result: options.result,
      analysis: failureAnalysis
    });
  }

  if (options.evidence?.executable) {
    options.workflow.phase = "verify";
    return null;
  }
  if (options.toolName === "write" || options.toolName === "edit" || options.toolName === "apply_patch") {
    options.workflow.phase = "implement";
    return null;
  }
  if (options.toolName === "todo") {
    options.workflow.phase = "plan";
    return null;
  }
  if (options.toolName === "bash" || options.toolName === "service" || options.toolName === "shell_session") {
    options.workflow.phase = options.result.ok ? "explore" : "repair";
    return null;
  }
  if (options.result.ok) options.workflow.phase = "explore";
  return null;
}

export function summarizeWorkflowState(workflow: WorkflowState, changedFiles: string[]): WorkflowStateSummary {
  const failurePatterns = [...workflow.failurePatterns.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, "en"));
  return {
    phase: workflow.phase,
    commands_tried: workflow.commandsTried.slice(-30),
    changed_files: changedFiles,
    ...(failurePatterns.length > 0 ? { failure_patterns: failurePatterns } : {})
  };
}
