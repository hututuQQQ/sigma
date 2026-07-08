import { compactLargeCommand, truncateMiddle } from "../compaction.js";
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

function numberMetadata(result: ToolResult, key: string): number | null | undefined {
  const value = result.metadata?.[key];
  if (typeof value === "number") return value;
  if (value === null) return null;
  return undefined;
}

function booleanMetadata(result: ToolResult, key: string): boolean {
  return result.metadata?.[key] === true;
}

function signalMetadata(result: ToolResult): string {
  const signal = result.metadata?.signal;
  return typeof signal === "string" ? signal : "";
}

function compactSummary(text: string, maxChars = 300): string {
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), maxChars).text;
}

function commandLooksCompileLike(command: string): boolean {
  return /\b(gcc|g\+\+|clang|clang\+\+|cc|c\+\+|javac|tsc|rustc|cargo\s+(?:build|check)|go\s+build|mvn|gradle|make|cmake|npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+build|bun\s+run\s+build)\b/i.test(command);
}

function outputLooksCompileLike(output: string): boolean {
  return /\b(error:|undefined reference|compilation failed|compile failed|syntaxerror|typeerror|ts\d{4}:|cannot find symbol)\b/i.test(output);
}

function categorizeFailure(options: {
  command: string | null;
  result: ToolResult;
}): WorkflowFailureCategory | null {
  if (options.result.ok) return null;
  const exitCode = numberMetadata(options.result, "exitCode");
  const output = options.result.content;
  const signal = signalMetadata(options.result);
  const combined = `${options.command ?? ""}\n${output}`.toLowerCase();

  if (
    booleanMetadata(options.result, "timedOut") ||
    exitCode === 124 ||
    /\btimedout:\s*true\b|\btimed out\b|\btimeout\b/.test(combined)
  ) {
    return "timeout";
  }
  if (
    exitCode === 139 ||
    exitCode === -11 ||
    signal === "SIGSEGV" ||
    /\bsegmentation fault\b|\bsigsegv\b/.test(combined)
  ) {
    return "segmentation_fault";
  }
  if (
    exitCode === 127 ||
    /\bcommand not found\b|\bnot found for validation\b|\bno such file or directory\b/.test(combined)
  ) {
    return "missing_tool";
  }
  if (
    commandLooksCompileLike(options.command ?? "") ||
    (outputLooksCompileLike(output) && /\b(error:|compilation failed|compile failed|syntaxerror|typeerror|cannot find symbol)\b/i.test(output))
  ) {
    return "compile_error";
  }
  return null;
}

function recordFailurePattern(options: {
  workflow: WorkflowState;
  category: WorkflowFailureCategory;
  toolName: string;
  command: string | null;
  result: ToolResult;
}): WorkflowFailurePatternSummary {
  const previous = options.workflow.failurePatterns.get(options.category);
  const exitCode = numberMetadata(options.result, "exitCode");
  const record: WorkflowFailurePatternSummary = {
    category: options.category,
    count: (previous?.count ?? 0) + 1,
    last_tool_name: options.toolName,
    ...(options.command ? { last_command: compactLargeCommand(options.command, 1200).text } : {}),
    ...(exitCode !== undefined ? { last_exit_code: exitCode } : {}),
    last_summary: compactSummary(options.result.content)
  };
  options.workflow.failurePatterns.set(options.category, record);
  return record;
}

function repairAdvice(category: WorkflowFailureCategory): string {
  if (category === "compile_error") {
    return "Use the compiler diagnostics as the repair target, fix the first concrete error, then rerun the same compile or a narrower syntax check.";
  }
  if (category === "segmentation_fault") {
    return "Switch to a focused crash-debug pass: isolate the smallest crashing command, inspect memory bounds and null/error returns, make one targeted change, then rerun that command.";
  }
  if (category === "timeout") {
    return "Reduce the scope before continuing: use a smaller input, shorter smoke command, or log/progress probe, then repair the slow path before broad exploration.";
  }
  return "Use an installed alternative or inspect the environment before retrying; do not repeat the same unavailable command.";
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
    repairAdvice(failure.category)
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

  const failureCategory = categorizeFailure({ command, result: options.result });
  if (failureCategory) {
    options.workflow.phase = "repair";
    return recordFailurePattern({
      workflow: options.workflow,
      category: failureCategory,
      toolName: options.toolName,
      command,
      result: options.result
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
