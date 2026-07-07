import type { AgentRunResult, HarnessCommandResult, HarnessRetryDecision, SummaryJson } from "../types.js";

function tailText(text: string, limit = 1600): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function inferFailureCategory(result: HarnessCommandResult): string {
  const combined = `${result.command}\n${result.stdout_tail}\n${result.stderr_tail}`.toLowerCase();
  if (result.timed_out || result.exit_code === 124 || combined.includes("timed out")) return "timeout";
  if (/\b(tsc|typecheck|type-check)\b/.test(combined)) return "typecheck";
  if (/\b(pytest|go test|cargo test|mvn test|gradle test|npm test|pnpm test|yarn test|bun test)\b/.test(combined)) return "test";
  if (/\b(eslint|lint)\b/.test(combined)) return "lint";
  if (/\b(build|compile)\b/.test(combined)) return "build";
  if (/syntaxerror|parse error|unexpected token|unterminated|syntax error/.test(combined)) return "syntax";
  if (/enoent|not found|command not found/.test(combined)) return "missing-tool-or-file";
  return "unknown";
}

export function formatFailureCard(result: HarnessCommandResult, index: number): string {
  const label = result.kind === "validation" ? "Validation" : "Precheck";
  const lines = [
    `${label} failure ${index + 1} card:`,
    `- command: ${result.command}`,
    `- exit code: ${result.exit_code}`,
    `- suspected category: ${inferFailureCategory(result)}`
  ];
  if (result.related_files.length > 0) {
    lines.push(`- related files: ${result.related_files.join(", ")}`);
  }
  const stdout = tailText(result.stdout_tail).trim();
  const stderr = tailText(result.stderr_tail).trim();
  if (stdout) lines.push(`- stdout tail:\n${stdout}`);
  if (stderr) lines.push(`- stderr tail:\n${stderr}`);
  return lines.join("\n");
}

export function retryTrigger(failedResults: HarnessCommandResult[]): HarnessRetryDecision["trigger"] {
  const kinds = new Set(failedResults.map((result) => result.kind));
  if (kinds.has("validation") && kinds.has("precheck")) return "validation+precheck";
  if (kinds.has("validation")) return "validation";
  if (kinds.has("precheck")) return "precheck";
  return "harness";
}

export function retryBudgetDecision(options: {
  retryNumber: number;
  startedAtMs: number;
  harnessTimeoutSec?: number;
  retryMinBudgetSec?: number;
  commandTimeoutSec?: number;
  validationTimeoutSec?: number;
  precheckTimeoutSec?: number;
  trigger: HarnessRetryDecision["trigger"];
}): HarnessRetryDecision {
  const minimum = Math.max(
    1,
    Math.floor(
      options.retryMinBudgetSec ??
        Math.max(options.precheckTimeoutSec ?? 0, options.validationTimeoutSec ?? 0, options.commandTimeoutSec ?? 60)
    )
  );
  const remaining =
    options.harnessTimeoutSec && options.harnessTimeoutSec > 0
      ? Math.max(0, Math.floor(options.harnessTimeoutSec - (Date.now() - options.startedAtMs) / 1000))
      : null;

  if (remaining !== null && remaining < minimum) {
    return {
      retry_number: options.retryNumber,
      action: "skipped",
      reason: "insufficient_run_controller_budget_for_retry",
      trigger: options.trigger,
      remaining_harness_budget_sec: remaining,
      minimum_retry_budget_sec: minimum
    };
  }

  return {
    retry_number: options.retryNumber,
    action: "started",
    reason: "budget_available",
    trigger: options.trigger,
    remaining_harness_budget_sec: remaining,
    minimum_retry_budget_sec: minimum
  };
}

export function instructionWithRetryFeedback(options: {
  originalInstruction: string;
  failedResults: HarnessCommandResult[];
  previousAttemptSummary: SummaryJson;
  previousAttemptResult: AgentRunResult;
  traceTail: string;
}): string {
  const lines = [
    options.originalInstruction,
    "",
    "The previous attempt failed post-run checks. Fix the issue and rerun the relevant checks before finishing."
  ];

  options.failedResults.forEach((result, index) => {
    lines.push("");
    lines.push(formatFailureCard(result, index));
  });

  lines.push("");
  lines.push("Previous attempt summary:");
  lines.push(
    JSON.stringify(
      {
        status: options.previousAttemptResult.status,
        finish_reason: options.previousAttemptResult.finishReason,
        turns: options.previousAttemptResult.turns,
        commands_executed: options.previousAttemptResult.commandsExecuted,
        last_error: options.previousAttemptResult.lastError
      },
      null,
      2
    )
  );

  if (options.traceTail.trim()) {
    lines.push("");
    lines.push("Trace tail key events (truncated):");
    lines.push(tailText(options.traceTail, 2000));
  }

  return lines.join("\n");
}
