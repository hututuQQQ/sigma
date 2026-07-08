import type { AgentRunResult, HarnessCommandResult, HarnessRetryDecision, SummaryJson } from "../types.js";
import { analyzeFailure, failureInputFromHarnessResult } from "../workflow/failure-analyzer.js";

function tailText(text: string, limit = 900): string {
  return text.length <= limit ? text : text.slice(-limit);
}

export function formatFailureCard(result: HarnessCommandResult, index: number): string {
  const label = result.kind === "validation" ? "Validation" : "Precheck";
  const analysis = analyzeFailure(failureInputFromHarnessResult(result));
  const lines = [
    `${label} failure ${index + 1} card:`,
    `- category: ${analysis?.category ?? "unknown"}`,
    `- command: ${result.command}`,
    `- exit code: ${result.exit_code}`,
    `- primary: ${analysis?.primaryMessage ?? result.message}`,
    `- next action: ${analysis?.suggestedNextAction ?? "Inspect the check output, make a focused repair, then rerun the relevant check."}`
  ];
  if (result.related_files.length > 0) {
    lines.push(`- related files: ${result.related_files.join(", ")}`);
  }
  const agentDiagnostics = analysis?.diagnostics.filter((diagnostic) => !diagnostic.startsWith("tool=")) ?? [];
  if (agentDiagnostics.length) {
    lines.push(`- diagnostics: ${agentDiagnostics.slice(0, 4).join("; ")}`);
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
        status: options.previousAttemptSummary.status,
        finish_reason: options.previousAttemptSummary.finish_reason,
        turns: options.previousAttemptSummary.turns,
        commands_executed: options.previousAttemptSummary.commands_executed,
        last_error: options.previousAttemptResult.lastError
      },
      null,
      2
    )
  );

  if (options.traceTail.trim()) {
    lines.push("");
    lines.push("Trace tail key events (truncated):");
    lines.push(tailText(options.traceTail, 1200));
  }

  return lines.join("\n");
}
