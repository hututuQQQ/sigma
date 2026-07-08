import { compactLargeCommand, truncateMiddle } from "../compaction.js";
import type { HarnessCommandResult, ToolResult, WorkflowFailureCategory } from "../types.js";

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
  primaryMessage: string;
  relatedCommand?: string;
  exitCode?: number | null;
  suggestedNextAction: string;
  diagnostics: string[];
}

export interface FailureAnalyzer {
  analyze(input: FailureAnalyzerInput): FailureAnalysis | null;
}

function normalizedCombined(input: FailureAnalyzerInput): string {
  return [
    input.toolName ?? "",
    input.command ?? "",
    input.output ?? "",
    input.stdout ?? "",
    input.stderr ?? ""
  ].join("\n").toLowerCase();
}

function combinedOutput(input: FailureAnalyzerInput): string {
  return [input.stderr ?? "", input.stdout ?? "", input.output ?? ""].filter(Boolean).join("\n");
}

function compactSingleLine(text: string, maxChars = 500): string {
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), maxChars).text;
}

function outputLines(input: FailureAnalyzerInput): string[] {
  return combinedOutput(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function primaryMessage(input: FailureAnalyzerInput, category: WorkflowFailureCategory): string {
  const interesting = outputLines(input).find((line) =>
    /\b(error|failed|failure|assert|exception|panic|fatal|timeout|timed out|not found|no such file|segmentation|sigsegv|ts\d{4}|undefined|cannot)\b/i.test(line)
  );
  if (interesting) return compactSingleLine(interesting);
  if (input.command) return `Command failed: ${compactSingleLine(input.command, 420)}`;
  return `Failure categorized as ${category}.`;
}

function commandLooksCompileLike(command: string): boolean {
  return /\b(gcc|g\+\+|clang|clang\+\+|cc|c\+\+|javac|tsc|rustc|cargo\s+(?:build|check)|go\s+build|mvn\s+(?:compile|package)|gradle\s+(?:build|compile)|make|cmake|npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+build|bun\s+run\s+build)\b/i.test(command);
}

function outputLooksCompileLike(output: string): boolean {
  return /\b(error:|undefined reference|compilation failed|compile failed|build failed|syntaxerror|typeerror|ts\d{4}:|cannot find symbol|undefined:|expected declaration|parse error|unexpected token|unterminated)\b/i.test(output);
}

function commandLooksTestLike(command: string): boolean {
  return /\b(pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|vitest|jest)\b/i.test(command);
}

function outputLooksTestLike(output: string): boolean {
  return /\b(assertionerror|failed tests?|test failed|tests? failed|failures?:|=== fail|--- fail|test result:\s*failed|not ok|expected .+ received|expected .+ got)\b/i.test(output);
}

function categoryForInput(input: FailureAnalyzerInput): WorkflowFailureCategory {
  const exitCode = input.exitCode;
  const signal = input.signal ?? "";
  const combined = normalizedCombined(input);
  const output = combinedOutput(input);
  const normalizedOutput = output.toLowerCase();
  const command = input.command ?? "";

  if (
    input.timedOut ||
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
    /\bcommand not found\b|\bnot found for validation\b|\bno such file or directory\b|\benoent\b|\bis not recognized as an internal or external command\b/.test(normalizedOutput)
  ) {
    return "missing_tool";
  }
  if (
    commandLooksCompileLike(command) ||
    (outputLooksCompileLike(output) && /\b(error:|compilation failed|compile failed|build failed|syntaxerror|typeerror|cannot find symbol|ts\d{4}:|undefined:|parse error)\b/i.test(output))
  ) {
    return "compile_error";
  }
  if (commandLooksTestLike(command) || outputLooksTestLike(output)) {
    return "test_failure";
  }
  return "unknown";
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

function diagnosticsForInput(input: FailureAnalyzerInput): string[] {
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

export class BuiltInFailureAnalyzer implements FailureAnalyzer {
  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    if (input.ok) return null;
    const category = categoryForInput(input);
    const command = input.command ? compactLargeCommand(input.command, 1200).text : undefined;
    return {
      category,
      primaryMessage: primaryMessage(input, category),
      ...(command ? { relatedCommand: command } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      suggestedNextAction: suggestedNextActionForFailure(category),
      diagnostics: diagnosticsForInput(input)
    };
  }
}

export const defaultFailureAnalyzer = new BuiltInFailureAnalyzer();

export function analyzeFailure(input: FailureAnalyzerInput, analyzer: FailureAnalyzer = defaultFailureAnalyzer): FailureAnalysis | null {
  return analyzer.analyze(input);
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
