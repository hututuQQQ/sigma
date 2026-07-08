import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runAgent, summaryJsonFromRunResult } from "../agent.js";
import { createSessionManager } from "../session/session-manager.js";
import type {
  AgentHarnessConfig,
  AgentHarnessSummary,
  AgentEvent,
  AgentRunResult,
  EvidenceRecord,
  HarnessCommandResult,
  SummaryJson
} from "../types.js";
import { changedWorkspaceFiles, listWorkspaceManifest } from "./manifest.js";
import { retryBudgetDecision, retryTrigger, instructionWithRetryFeedback } from "./retry.js";
import { runPostRunCleanup } from "./cleanup.js";
import { aggregateAttemptResults, relativeArtifactPath, summaryFromAttempt } from "./summary.js";
import { runHarnessCommand } from "./validation.js";
import { planValidationCommandSpecs } from "./validation-planner.js";
import { finalizeManagedServices } from "../tools/service.js";
import { redactSecrets, redactSecretText } from "../redaction.js";
import { evidenceKindForCommand } from "../controller/evidence.js";

const DEFAULT_VALIDATION_TIMEOUT_SEC = 60;
const DEFAULT_PRECHECK_TIMEOUT_SEC = 60;

function emitHarnessEvent(
  config: AgentHarnessConfig,
  type: "harness_check_start" | "harness_check_end",
  metadata: Record<string, unknown>
): void {
  config.eventBus?.emit(redactSecrets({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    runId: "harness",
    provider: config.modelClient.provider,
    model: config.modelClient.model,
    metadata
  }));
}

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
      last_error: summary.last_error
    },
    null,
    2
  );
}

function failedResults(results: HarnessCommandResult[]): HarnessCommandResult[] {
  return results.filter((result) => result.exit_code !== 0);
}

function evidenceRecordsFromHarnessResults(results: HarnessCommandResult[]): EvidenceRecord[] {
  return results
    .filter((result) => result.exit_code === 0)
    .map((result) => ({
      kind: evidenceKindForCommand(result.command),
      toolName: `harness.${result.kind}`,
      ok: true,
      executable: true,
      command: result.command,
      summary: result.message,
      relatedFiles: result.related_files,
      exitCode: result.exit_code,
      timestamp: new Date().toISOString()
    }));
}

function harnessEnabled(config: AgentHarnessConfig): boolean {
  return (
    config.validationMode === "auto" ||
    Boolean(config.precheckCommand?.trim()) ||
    (config.postRunCleanupGlobs?.length ?? 0) > 0 ||
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
    for (const spec of await planValidationCommandSpecs({
      workspacePath,
      configuredCommands: options.config.validationCommands ?? [],
      changedFiles
    })) {
      emitHarnessEvent(options.config, "harness_check_start", {
        kind: "validation",
        source: spec.source,
        attempt: options.attempt,
        command: spec.command
      });
      const result = await runHarnessCommand({
        kind: "validation",
        source: spec.source,
        command: spec.command,
        workspacePath,
        attempt: options.attempt,
        timeoutSec: validationTimeoutSec,
        relatedFiles: spec.relatedFiles,
        abortSignal: options.config.abortSignal
      });
      emitHarnessEvent(options.config, "harness_check_end", {
        kind: "validation",
        source: spec.source,
        attempt: options.attempt,
        exitCode: result.exit_code,
        durationMs: result.duration_ms
      });
      results.push(result);
    }
  }

  const traceTail = await readTraceTail(options.attemptTracePath);
  const feedbackSummary = summaryFeedback(options.attemptSummary);
  for (const result of results) {
    result.agent_summary = feedbackSummary;
    result.trace_tail = traceTail;
  }

  return { results, traceTail };
}

async function runPrecheckBeforeAttempt(options: {
  config: AgentHarnessConfig;
  attempt: number;
}): Promise<HarnessCommandResult | null> {
  if (!options.config.precheckCommand?.trim()) return null;
  const command = options.config.precheckCommand;
  emitHarnessEvent(options.config, "harness_check_start", {
    kind: "precheck",
    source: "precheck",
    attempt: options.attempt,
    command
  });
  const result = await runHarnessCommand({
    kind: "precheck",
    source: "precheck",
    command,
    workspacePath: path.resolve(options.config.workspacePath),
    attempt: options.attempt,
    timeoutSec: options.config.precheckTimeoutSec ?? DEFAULT_PRECHECK_TIMEOUT_SEC,
    relatedFiles: [],
    abortSignal: options.config.abortSignal
  });
  emitHarnessEvent(options.config, "harness_check_end", {
    kind: "precheck",
    source: "precheck",
    attempt: options.attempt,
    exitCode: result.exit_code,
    durationMs: result.duration_ms
  });
  return result;
}

function finalResultForHarness(options: {
  attempts: AgentRunResult[];
  finalAttempt: AgentRunResult;
  harness: AgentHarnessSummary;
  failed: HarnessCommandResult[];
  failureMessage: string | null;
  sessionId?: string;
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
  const evidenceRecords = [
    ...(options.finalAttempt.evidenceRecords ?? []),
    ...evidenceRecordsFromHarnessResults([
      ...options.harness.validation_results,
      ...options.harness.precheck_results
    ])
  ];
  return {
    sessionId: options.sessionId ?? options.finalAttempt.sessionId,
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
    harness: options.harness,
    toolsAvailable: options.finalAttempt.toolsAvailable,
    changedFiles: options.finalAttempt.changedFiles,
    todoItems: options.finalAttempt.todoItems,
    projectInstructionSources: options.finalAttempt.projectInstructionSources,
    contextMode: options.finalAttempt.contextMode,
    repoMapChars: options.finalAttempt.repoMapChars,
    mcpServers: options.finalAttempt.mcpServers,
    workflow: options.finalAttempt.workflow,
    evidenceRecords,
    finalGate: options.finalAttempt.finalGate,
    selectedSkills: options.finalAttempt.selectedSkills
  };
}

async function writeHarnessSummary(result: AgentRunResult, summaryJsonPath?: string): Promise<void> {
  if (!summaryJsonPath) return;
  const summary = summaryFromAttempt(result);
  summary.harness = result.harness;
  const resolved = path.resolve(summaryJsonPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(redactSecrets(summary), null, 2)}\n`, "utf8");
}

export async function runAgentHarness(config: AgentHarnessConfig): Promise<AgentRunResult> {
  if (!harnessEnabled(config)) {
    return await runAgent(config);
  }

  const startedAtMs = Date.now();
  const workspacePath = path.resolve(config.workspacePath);
  const summaryDir = path.dirname(path.resolve(config.summaryJsonPath ?? path.join(config.workspacePath, ".agent", "summary.json")));
  const attemptsDir = path.resolve(config.attemptsDir ?? path.join(summaryDir, "attempts"));
  await mkdir(attemptsDir, { recursive: true });
  const durableSession = config.durableSession === false
    ? null
    : await createSessionManager({
        sessionId: config.sessionId,
        runId: randomUUID(),
        instruction: config.instruction,
        workspacePath,
        provider: config.modelClient.provider,
        model: config.modelClient.model,
        sessionRootDir: config.sessionRootDir,
        traceJsonlPath: config.traceJsonlPath,
        sessionJsonlPath: config.sessionJsonlPath,
        summaryJsonPath: config.summaryJsonPath,
        parentSessionId: config.parentSessionId,
        forkedFromSessionId: config.forkedFromSessionId
      });
  const pendingEventWrites: Promise<void>[] = [];
  const parentEventWriteErrors: string[] = [];
  let activeAttemptForEvents: number | null = null;
  const enqueueParentEventWrite = (agentEvent: AgentEvent): void => {
    if (!durableSession) return;
    const write = durableSession.appendEvent(agentEvent).catch((error) => {
      parentEventWriteErrors.push(redactSecretText(error instanceof Error ? error.message : String(error)));
    });
    pendingEventWrites.push(write);
  };
  const settleParentEventWrites = async (): Promise<void> => {
    if (pendingEventWrites.length === 0) return;
    await Promise.allSettled(pendingEventWrites.splice(0));
  };
  const controllerEventBus = {
    emit(agentEvent: AgentEvent): void {
      const enriched: AgentEvent = {
        ...agentEvent,
        ...(durableSession?.sessionId ? { sessionId: durableSession.sessionId } : {}),
        metadata: {
          ...(agentEvent.metadata ?? {}),
          ...(activeAttemptForEvents !== null ? { attempt: activeAttemptForEvents } : {})
        }
      };
      enqueueParentEventWrite(enriched);
      config.eventBus?.emit(enriched);
    }
  };
  const controllerConfig: AgentHarnessConfig = { ...config, eventBus: controllerEventBus };

  const attempts: AgentRunResult[] = [];
  const validationResults: HarnessCommandResult[] = [];
  const precheckResults: HarnessCommandResult[] = [];
  const harness: AgentHarnessSummary = {
    attempts: [],
    validation_results: validationResults,
    precheck_results: precheckResults,
    retry_decisions: [],
    managed_service_finalization: null,
    post_run_cleanup: null
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
    activeAttemptForEvents = attempt;
    const precheck = await runPrecheckBeforeAttempt({ config: controllerConfig, attempt });
    if (precheck) {
      precheckResults.push(precheck);
      if (precheck.exit_code !== 0) {
        lastFailed = [precheck];
        failureMessage = precheck.message;
        break;
      }
    }

    const beforeManifest = config.validationMode === "auto" ? await listWorkspaceManifest(config.workspacePath) : null;

    const rawAttemptResult = await runAgent({
      ...controllerConfig,
      instruction: activeInstruction,
      summaryJsonPath: attemptSummaryPath,
      traceJsonlPath: attemptTracePath,
      durableSession: false
    });
    const attemptCancelled = rawAttemptResult.finishReason === "cancelled" || config.abortSignal?.aborted === true;
    const attemptResult: AgentRunResult = attemptCancelled && rawAttemptResult.finishReason !== "cancelled"
      ? {
          ...rawAttemptResult,
          status: "stopped",
          finishReason: "cancelled",
          lastError: rawAttemptResult.lastError ?? "Run cancelled."
        }
      : rawAttemptResult;
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

    if (attemptCancelled) {
      failureMessage = attemptResult.lastError ?? "Run cancelled.";
      lastFailed = [];
      break;
    }

    if (attemptResult.status === "error") {
      failureMessage = attemptResult.lastError;
      break;
    }

    const { results, traceTail } = await runChecks({
      config: controllerConfig,
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
      failureMessage = lastFailed[lastFailed.length - 1]?.message ?? "post-run checks failed";
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
      failureMessage = `${lastFailed[lastFailed.length - 1]?.message ?? "post-run checks failed"}; retry skipped because run-controller budget remaining (${decision.remaining_harness_budget_sec}s) is below ${decision.minimum_retry_budget_sec}s`;
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
  activeAttemptForEvents = null;

  harness.managed_service_finalization = await finalizeManagedServices();
  harness.post_run_cleanup = await runPostRunCleanup(config.postRunCleanupGlobs ?? []);
  const fallbackAttempt: AgentRunResult = {
    sessionId: durableSession?.sessionId,
    status: "error",
    finishReason: "precheck_failed",
    turns: 0,
    toolCalls: 0,
    commandsExecuted: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 },
    provider: config.modelClient.provider,
    model: config.modelClient.model,
    durationMs: Date.now() - startedAtMs,
    lastError: failureMessage,
    toolsAvailable: [],
    changedFiles: [],
    todoItems: [],
    projectInstructionSources: [],
    contextMode: config.contextMode,
    mcpServers: config.mcpServers,
    evidenceRecords: [],
    selectedSkills: []
  };
  const finalAttempt = attempts[attempts.length - 1] ?? fallbackAttempt;
  const finalResult = finalResultForHarness({
    attempts,
    finalAttempt,
    harness,
    failed: lastFailed,
    failureMessage,
    sessionId: durableSession?.sessionId
  });

  await writeHarnessSummary(finalResult, config.summaryJsonPath);
  if (config.traceJsonlPath && finalTracePath) {
    await mkdir(path.dirname(path.resolve(config.traceJsonlPath)), { recursive: true });
    await copyFile(finalTracePath, config.traceJsonlPath);
  }
  await settleParentEventWrites();
  void parentEventWriteErrors;
  await durableSession?.complete(finalResult, summaryJsonFromRunResult(finalResult));

  return finalResult;
}
