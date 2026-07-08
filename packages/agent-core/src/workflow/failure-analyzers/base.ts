import { compactLargeCommand, truncateMiddle } from "../../compaction.js";
import type { HarnessCommandResult, ToolResult, WorkflowFailureCategory } from "../../types.js";

export interface FailureAnalyzerInput {
  ok?: boolean;
  toolName?: string;
  command?: string | null;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string | null;
}

export interface FailureAnalysis {
  category: WorkflowFailureCategory;
  confidence: number;
  primaryMessage: string;
  relatedCommand?: string;
  relatedFiles: string[];
  failingTestNames: string[];
  firstActionableLine?: string;
  exitCode?: number | null;
  suggestedNextAction: string;
  diagnostics: string[];
  rerunCommandSuggestion?: string;
  shouldAvoidRepeatingCommand?: boolean;
}

export interface FailureAnalyzer {
  readonly name: string;
  analyze(input: FailureAnalyzerInput): FailureAnalysis | null;
}

export function combinedOutput(input: FailureAnalyzerInput): string {
  return [input.stderr ?? "", input.stdout ?? "", input.output ?? ""].filter(Boolean).join("\n");
}

export function normalizedCombined(input: FailureAnalyzerInput): string {
  return [
    input.toolName ?? "",
    input.command ?? "",
    input.output ?? "",
    input.stdout ?? "",
    input.stderr ?? ""
  ].join("\n").toLowerCase();
}

export function compactSingleLine(text: string, maxChars = 500): string {
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), maxChars).text;
}

export function outputLines(input: FailureAnalyzerInput): string[] {
  return combinedOutput(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function command(input: FailureAnalyzerInput): string {
  return input.command ?? "";
}

export function compactCommand(input: FailureAnalyzerInput): string | undefined {
  return input.command ? compactLargeCommand(input.command, 1200).text : undefined;
}

export function firstActionableLine(input: FailureAnalyzerInput, pattern?: RegExp): string | undefined {
  const lines = outputLines(input);
  const line = pattern
    ? lines.find((candidate) => pattern.test(candidate))
    : lines.find((candidate) =>
        /\b(error|failed|failure|assert|exception|panic|fatal|timeout|timed out|not found|no such file|segmentation|sigsegv|ts\d{4}|undefined|cannot)\b/i.test(candidate)
      );
  return line ? compactSingleLine(line) : undefined;
}

export function primaryMessage(input: FailureAnalyzerInput, category: WorkflowFailureCategory, pattern?: RegExp): string {
  const actionable = firstActionableLine(input, pattern);
  if (actionable) return actionable;
  if (input.command) return `Command failed: ${compactSingleLine(input.command, 420)}`;
  return `Failure categorized as ${category}.`;
}

export function suggestedNextActionForFailure(category: WorkflowFailureCategory): string {
  if (category === "compile_error") {
    return "Use the compiler diagnostics as the repair target, fix the first concrete error, then rerun the same compile or a narrower syntax check.";
  }
  if (category === "test_failure") {
    return "Use the failing test assertion or test name as the repair target, make one focused change, then rerun the same test or a narrower related test.";
  }
  if (category === "segmentation_fault") {
    return "Switch to a focused crash-debug pass: isolate the smallest crashing command, inspect memory bounds and null/error returns, make one targeted change, then rerun that command.";
  }
  if (category === "timeout") {
    return "Reduce the scope before continuing: use a smaller input, shorter smoke command, or log/progress probe, then repair the slow path before broad exploration.";
  }
  if (category === "missing_tool") {
    return "Use an installed alternative or inspect the environment before retrying; do not repeat the same unavailable command.";
  }
  return "Inspect the command output, identify the first actionable diagnostic, make a focused repair, then rerun the relevant check.";
}

export function baseDiagnostics(input: FailureAnalyzerInput): string[] {
  const diagnostics: string[] = [];
  if (input.toolName) diagnostics.push(`tool=${input.toolName}`);
  if (input.timedOut) diagnostics.push("timed_out=true");
  if (input.signal) diagnostics.push(`signal=${input.signal}`);
  if (input.exitCode !== undefined) diagnostics.push(`exit_code=${input.exitCode}`);
  for (const line of outputLines(input).slice(0, 3)) {
    diagnostics.push(compactSingleLine(line, 300));
  }
  return diagnostics;
}

export function relatedFilesFromOutput(input: FailureAnalyzerInput): string[] {
  const text = [input.command ?? "", combinedOutput(input)].join("\n");
  const files = new Set<string>();
  const patterns = [
    /((?:[A-Za-z]:)?[./\\]?[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|json|toml|yaml|yml))(?::|\(|\s|$)/g,
    /(FAILED|FAIL)\s+([\w./\\-]+\.(?:py|ts|tsx|js|jsx|go|rs))/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[2] ?? match[1];
      if (value && !/^(FAILED|FAIL)$/.test(value)) files.add(value.replace(/\\/g, "/"));
    }
  }
  return [...files].slice(0, 12);
}

export function failingTestsFromOutput(input: FailureAnalyzerInput): string[] {
  const text = combinedOutput(input);
  const tests = new Set<string>();
  const patterns = [
    /([\w./\\-]+\.py::[\w:[\].-]+)/g,
    /--- FAIL:\s+([\w./-]+)/g,
    /FAIL\s+([\w./\\-]+\.(?:test|spec)\.[jt]sx?)/g,
    /test\s+([\w:.-]+)\s+\.\.\.\s+FAILED/g,
    /failures:\s+([\w:.-]+)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) tests.add(match[1]);
    }
  }
  return [...tests].slice(0, 12);
}

export function analysis(options: {
  input: FailureAnalyzerInput;
  category: WorkflowFailureCategory;
  confidence: number;
  analyzerName: string;
  primaryPattern?: RegExp;
  diagnostics?: string[];
  relatedFiles?: string[];
  failingTestNames?: string[];
  rerunCommandSuggestion?: string;
  shouldAvoidRepeatingCommand?: boolean;
}): FailureAnalysis {
  const relatedCommand = compactCommand(options.input);
  const actionable = firstActionableLine(options.input, options.primaryPattern);
  return {
    category: options.category,
    confidence: options.confidence,
    primaryMessage: primaryMessage(options.input, options.category, options.primaryPattern),
    ...(relatedCommand ? { relatedCommand } : {}),
    relatedFiles: options.relatedFiles ?? relatedFilesFromOutput(options.input),
    failingTestNames: options.failingTestNames ?? failingTestsFromOutput(options.input),
    ...(actionable ? { firstActionableLine: actionable } : {}),
    ...(options.input.exitCode !== undefined ? { exitCode: options.input.exitCode } : {}),
    suggestedNextAction: suggestedNextActionForFailure(options.category),
    diagnostics: [`analyzer=${options.analyzerName}`, ...baseDiagnostics(options.input), ...(options.diagnostics ?? [])],
    ...(options.rerunCommandSuggestion ? { rerunCommandSuggestion: options.rerunCommandSuggestion } : {}),
    ...(options.shouldAvoidRepeatingCommand !== undefined
      ? { shouldAvoidRepeatingCommand: options.shouldAvoidRepeatingCommand }
      : {})
  };
}

export function failureInputFromToolResult(options: {
  toolName: string;
  command: string | null;
  result: ToolResult;
}): FailureAnalyzerInput {
  const exitCode = options.result.metadata?.exitCode;
  const signal = options.result.metadata?.signal;
  return {
    ok: options.result.ok,
    toolName: options.toolName,
    command: options.command,
    output: options.result.content,
    exitCode: typeof exitCode === "number" || exitCode === null ? exitCode : undefined,
    timedOut: options.result.metadata?.timedOut === true,
    signal: typeof signal === "string" ? signal : undefined
  };
}

export function failureInputFromHarnessResult(result: HarnessCommandResult): FailureAnalyzerInput {
  return {
    ok: result.exit_code === 0,
    toolName: `harness.${result.kind}`,
    command: result.command,
    stdout: result.stdout_tail,
    stderr: result.stderr_tail,
    exitCode: result.exit_code,
    timedOut: result.timed_out === true,
    signal: result.signal ?? undefined
  };
}
