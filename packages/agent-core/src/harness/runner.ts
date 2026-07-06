import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "../agent.js";
import type {
  AgentHarnessConfig,
  AgentHarnessSummary,
  AgentRunResult,
  HarnessCommandResult,
  SummaryJson
} from "../types.js";
import { changedWorkspaceFiles, listWorkspaceManifest } from "./manifest.js";
import { retryBudgetDecision, retryTrigger, instructionWithRetryFeedback } from "./retry.js";
import { runPreVerifierCleanup } from "./cleanup.js";
import { aggregateAttemptResults, relativeArtifactPath, summaryFromAttempt } from "./summary.js";
import { runHarnessCommand, validationCommandSpecs } from "./validation.js";
import { cleanupServicesBeforeVerifier } from "../tools/service.js";

const DEFAULT_VALIDATION_TIMEOUT_SEC = 60;
const DEFAULT_PRECHECK_TIMEOUT_SEC = 60;

async function readTraceTail(tracePath: string, maxBytes = 16000): Promise<string> {
  try {
    const content = await readFile(tracePath, "utf8");
    return content.length <= maxBytes ? content : content.slice(-maxBytes);
  } catch {
    return "";
  }
}

function summaryFeedback(summary: SummaryJson): string {
  return JSON.stringify(
    {
      status: summary.status,
      finish_reason: summary.finish_reason,
      turns: summary.turns,
      commands_executed: summary.commands_executed,
      last_error: summary.last_error,
      validation_commands: summary.validation_commands ?? []
    },
    null,
    2
  );
}

function failedResults(results: HarnessCommandResult[]): HarnessCommandResult[] {
  return results.filter((result) => result.exit_code !== 0);
}

function harnessEnabled(config: AgentHarnessConfig): boolean {
  return (
    config.validationMode === "auto" ||
    Boolean(config.precheckCommand?.trim()) ||
    (config.preVerifierCleanupGlobs?.length ?? 0) > 0 ||
    (config.validationRetryLimit ?? 0) > 0 ||
    Boolean(config.attemptsDir)
  );
}

async function runChecks(options: {
  config: AgentHarnessConfig;
  attempt: number;
  beforeManifest: Awaited<ReturnType<typeof listWorkspaceManifest>> | null;
  attemptSummary: SummaryJson;
  attemptTracePath: string;
}): Promise<{ results: HarnessCommandResult[]; traceTail: string }> {
  const results: HarnessCommandResult[] = [];
  const workspacePath = path.resolve(options.config.workspacePath);
  const validationTimeoutSec = options.config.validationTimeoutSec ?? DEFAULT_VALIDATION_TIMEOUT_SEC;

  if (options.config.validationMode === "auto") {
    const afterManifest = await listWorkspaceManifest(workspacePath);
    const changedFiles = options.beforeManifest ? changedWorkspaceFiles(options.beforeManifest, afterManifest) : [];
    for (const spec of validationCommandSpecs(options.attemptSummary, changedFiles)) {
      results.push(
        await runHarnessCommand({
          kind: "validation",
          source: spec.source,
          command: spec.command,
          workspacePath,
          attempt: options.attempt,
          timeoutSec: validationTimeoutSec,
          relatedFiles: spec.relatedFiles
        })
      );
    }
  }

  if (options.config.precheckCommand?.trim()) {
    results.push(
      await runHarnessCommand({
        kind: "precheck",
        source: "precheck",
        command: options.config.precheckCommand,
        workspacePath,
        attempt: options.attempt,
        timeoutSec: options.config.precheckTimeoutSec ?? DEFAULT_PRECHECK_TIMEOUT_SEC,
        relatedFiles: []
      })
    );
  }

  const traceTail = await readTraceTail(options.attemptTracePath);
  const feedbackSummary = summaryFeedback(options.attemptSummary);
  for (const result of results) {
    result.agent_summary = feedbackSummary;
    result.trace_tail = traceTail;
  }

  return { results, traceTail };
}

function finalResultForHarness(options: {
  attempts: AgentRunResult[];
  finalAttempt: AgentRunResult;
  harness: AgentHarnessSummary;
  failed: HarnessCommandResult[];
  failureMessage: string | null;
}): AgentRunResult {
  const aggregate = aggregateAttemptResults(options.attempts);
  const firstFailure = options.failed[0];
  const finishReason =
    firstFailure?.kind === "precheck"
      ? "precheck_failed"
      : firstFailure?.kind === "validation"
        ? "validation_failed"
        : options.finalAttempt.finishReason;
  const status = firstFailure ? "error" : options.finalAttempt.status;
  return {
    status,
    finishReason,
    turns: aggregate.turns,
    toolCalls: aggregate.toolCalls,
    commandsExecuted: aggregate.commandsExecuted,
    usage: aggregate.usage,
    provider: options.finalAttempt.provider,
    model: options.finalAttempt.model,
    durationMs: aggregate.durationMs,
    lastError: options.failureMessage ?? options.finalAttempt.lastError,
    finalMessage: options.finalAttempt.finalMessage,
    harness: options.harness
  };
}

async function writeHarnessSummary(result: AgentRunResult, summaryJsonPath?: string): Promise<void> {
  if (!summaryJsonPath) return;
  const summary = summaryFromAttempt(result);
  summary.harness = result.harness;
  if (result.harness) {
    const validationCommands = result.harness.validation_results.map((item) => item.command);
    if (validationCommands.length > 0) {
      summary.validation_commands = [...new Set([...(summary.validation_commands ?? []), ...validationCommands])];
    }
  }
  const resolved = path.resolve(summaryJsonPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export async function runAgentHarness(config: AgentHarnessConfig): Promise<AgentRunResult> {
  if (!harnessEnabled(config)) {
    return await runAgent(config);
  }

  const startedAtMs = Date.now();
  const summaryDir = path.dirname(path.resolve(config.summaryJsonPath ?? path.join(config.workspacePath, ".agent", "summary.json")));
  const attemptsDir = path.resolve(config.attemptsDir ?? path.join(summaryDir, "attempts"));
  await mkdir(attemptsDir, { recursive: true });

  const attempts: AgentRunResult[] = [];
  const validationResults: HarnessCommandResult[] = [];
  const precheckResults: HarnessCommandResult[] = [];
  const harness: AgentHarnessSummary = {
    attempts: [],
    validation_results: validationResults,
    precheck_results: precheckResults,
    retry_decisions: [],
    service_cleanup: null,
    pre_verifier_cleanup: null
  };

  const retryLimit = Math.max(0, Math.floor(config.validationRetryLimit ?? 0));
  let activeInstruction = config.instruction;
  let finalAttemptSummary: SummaryJson | null = null;
  let finalTracePath = "";
  let lastFailed: HarnessCommandResult[] = [];
  let failureMessage: string | null = null;

  for (let attempt = 1; ; attempt += 1) {
    const attemptDir = path.join(attemptsDir, `attempt-${attempt}`);
    const attemptSummaryPath = path.join(attemptDir, "summary.json");
    const attemptTracePath = path.join(attemptDir, "trace.jsonl");
    await mkdir(attemptDir, { recursive: true });
    const beforeManifest = config.validationMode === "auto" ? await listWorkspaceManifest(config.workspacePath) : null;

    const attemptResult = await runAgent({
      ...config,
      instruction: activeInstruction,
      summaryJsonPath: attemptSummaryPath,
      traceJsonlPath: attemptTracePath
    });
    attempts.push(attemptResult);
    finalTracePath = attemptTracePath;
    finalAttemptSummary = summaryFromAttempt(attemptResult);
    harness.attempts.push({
      attempt,
      status: attemptResult.status,
      finish_reason: attemptResult.finishReason,
      summary_path: relativeArtifactPath(attemptSummaryPath, summaryDir),
      trace_path: relativeArtifactPath(attemptTracePath, summaryDir)
    });

    if (attemptResult.status === "error") {
      failureMessage = attemptResult.lastError;
      break;
    }

    const { results, traceTail } = await runChecks({
      config,
      attempt,
      beforeManifest,
      attemptSummary: finalAttemptSummary,
      attemptTracePath
    });
    validationResults.push(...results.filter((result) => result.kind === "validation"));
    precheckResults.push(...results.filter((result) => result.kind === "precheck"));
    lastFailed = failedResults(results);
    if (lastFailed.length === 0) break;

    if (attempt > retryLimit) {
      failureMessage = lastFailed[lastFailed.length - 1]?.message ?? "harness validation failed";
      break;
    }

    const trigger = retryTrigger(lastFailed);
    const decision = retryBudgetDecision({
      retryNumber: attempt,
      startedAtMs,
      harnessTimeoutSec: config.harnessTimeoutSec,
      retryMinBudgetSec: config.retryMinBudgetSec,
      commandTimeoutSec: config.commandTimeoutSec,
      validationTimeoutSec: config.validationTimeoutSec,
      precheckTimeoutSec: config.precheckTimeoutSec,
      trigger
    });
    harness.retry_decisions.push(decision);
    if (decision.action === "skipped") {
      failureMessage = `${lastFailed[lastFailed.length - 1]?.message ?? "harness validation failed"}; retry skipped because harness budget remaining (${decision.remaining_harness_budget_sec}s) is below ${decision.minimum_retry_budget_sec}s`;
      break;
    }

    activeInstruction = instructionWithRetryFeedback({
      originalInstruction: config.instruction,
      failedResults: lastFailed,
      previousAttemptSummary: finalAttemptSummary,
      previousAttemptResult: attemptResult,
      traceTail
    });
  }

  harness.service_cleanup = await cleanupServicesBeforeVerifier();
  harness.pre_verifier_cleanup = await runPreVerifierCleanup(config.preVerifierCleanupGlobs ?? []);
  const finalAttempt = attempts[attempts.length - 1];
  const finalResult = finalResultForHarness({
    attempts,
    finalAttempt,
    harness,
    failed: lastFailed,
    failureMessage
  });

  await writeHarnessSummary(finalResult, config.summaryJsonPath);
  if (config.traceJsonlPath && finalTracePath) {
    await mkdir(path.dirname(path.resolve(config.traceJsonlPath)), { recursive: true });
    await copyFile(finalTracePath, config.traceJsonlPath);
  }

  return finalResult;
}
