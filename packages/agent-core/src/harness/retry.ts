import type { AgentRunResult, HarnessCommandResult, HarnessRetryDecision, SummaryJson } from "../types.js";

function tailText(text: string, limit = 6000): string {
  return text.length <= limit ? text : text.slice(-limit);
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
      reason: "insufficient_harness_budget_for_retry",
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
    "The previous attempt failed harness validation. Fix the issue and rerun validation before finishing."
  ];

  options.failedResults.forEach((result, index) => {
    const label = result.kind === "validation" ? "Validation" : "Precheck";
    lines.push("");
    lines.push(`${label} failure ${index + 1}:`);
    lines.push(`- command: ${result.command}`);
    lines.push(`- exit code: ${result.exit_code}`);
    if (result.related_files.length > 0) lines.push(`- related files: ${result.related_files.join(", ")}`);
    if (result.stdout_tail.trim()) lines.push(`- stdout tail:\n${tailText(result.stdout_tail)}`);
    if (result.stderr_tail.trim()) lines.push(`- stderr tail:\n${tailText(result.stderr_tail)}`);
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
    lines.push("Trace tail key events:");
    lines.push(tailText(options.traceTail));
  }

  return lines.join("\n");
}
