import { writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, writeJson } from "./common.mjs";
import { classifyTrace } from "./trace-attribution-classifier.mjs";
import { elapsedMs, firstEvent, lastEvent, traceTurns } from "./trace-attribution-events.mjs";
import {
  distribution,
  eventRef,
  reportWithDigest,
  safeLabel,
  TOKEN_ESTIMATOR,
  TRACE_ATTRIBUTION_SCHEMA_ID,
  TRACE_ATTRIBUTION_SCHEMA_VERSION,
  TRACE_ATTRIBUTION_VERSION,
  tokenUsageAttribution
} from "./trace-attribution-schema.mjs";

function requestComposition(prompt) {
  const observation = prompt?.payload?.traceObservation;
  const tokens = observation?.estimatedTokens;
  if (!tokens) return {
    accuracy: "unavailable",
    estimator: TOKEN_ESTIMATOR,
    systemBaseContext: null,
    toolSchema: null,
    conversationHistory: null,
    toolResults: null,
    total: null
  };
  return {
    accuracy: "estimated",
    estimator: observation.tokenEstimator,
    systemBaseContext: tokens.systemBaseContext,
    toolSchema: tokens.toolSchema,
    conversationHistory: tokens.conversationHistory,
    toolResults: tokens.toolResults,
    total: tokens.total
  };
}

function allocateInteger(total, weights) {
  const entries = Object.entries(weights);
  const denominator = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!Number.isFinite(total) || denominator <= 0) return null;
  let remaining = total;
  return Object.fromEntries(entries.map(([key, value], index) => {
    const allocation = index === entries.length - 1
      ? remaining : Math.floor(total * value / denominator);
    remaining -= allocation;
    return [key, allocation];
  }));
}

function proxyAttribution(usage, composition) {
  const accounted = usage.accounted;
  if ([accounted.inputTokens, accounted.outputTokens, accounted.cacheReadTokens, composition.total]
    .some((value) => value === null)) return { accuracy: "unavailable", components: null };
  const uncachedInput = Math.max(0, accounted.inputTokens - accounted.cacheReadTokens);
  const input = allocateInteger(uncachedInput, {
    systemBaseContext: composition.systemBaseContext,
    toolSchema: composition.toolSchema,
    conversationHistory: composition.conversationHistory,
    toolResults: composition.toolResults
  });
  if (!input) return { accuracy: "unavailable", components: null };
  return {
    accuracy: usage.providerReported.accuracy === "provider_native"
      ? "estimated_allocation_over_provider_or_adapter_usage" : "estimated_allocation",
    components: { ...input, modelOutput: accounted.outputTokens }
  };
}

function modelLatency(turn) {
  const terminal = turn.model.completion ?? turn.model.failure;
  const usageLatency = turn.model.usage?.latencyMs;
  const toolDurations = turn.calls.map((call) => call.result?.durationMs).filter(Number.isFinite);
  const completeToolTiming = toolDurations.length === turn.calls.length;
  return {
    modelCallMs: Number.isFinite(usageLatency) ? Math.max(0, Math.round(usageLatency)) : elapsedMs(turn.startEvent, terminal),
    modelCallSource: Number.isFinite(usageLatency) ? "runtime_usage_record" : "event_lifecycle",
    toolExecutionMs: completeToolTiming
      ? toolDurations.reduce((total, value) => total + value, 0) : null,
    toolExecutionObservedCount: toolDurations.length,
    toolExecutionAccuracy: completeToolTiming ? "runtime_exact" : "unavailable_or_partial",
    totalTurnMs: elapsedMs(turn.startEvent, turn.boundaryEvent)
  };
}

function validationState(turn, classified) {
  const repeatedRefs = new Set(classified.repeats.validations.map((item) => item.currentRef?.eventId));
  const refs = [
    ...turn.calls.filter((call) => call.validation).map((call) => call.requestedRef),
    ...turn.states.validationEvents.map(eventRef)
  ].filter(Boolean);
  return {
    observed: refs.length > 0,
    statuses: [...new Set(turn.states.validationEvents.map((event) => event.payload?.status ?? "observed"))],
    repeatedWithoutMutation: refs.some((ref) => repeatedRefs.has(ref.eventId)),
    sourceRefs: refs
  };
}

function callToolResults(turn) {
  return turn.calls.filter((call) => call.result).map((call) => ({
    toolName: call.toolName,
    callRef: call.requestedRef,
    ...call.result
  }));
}

function callConfiguration(turn, metadata, redactor) {
  const started = turn.startEvent.payload ?? {};
  const completed = turn.model.completion?.payload ?? {};
  const usage = turn.model.usage ?? {};
  return {
    provider: safeLabel(usage.providerId ?? started.provider ?? metadata.provider, redactor),
    resolvedModel: safeLabel(usage.modelId ?? completed.model ?? started.model ?? metadata.model, redactor),
    reasoningEffort: safeLabel(metadata.reasoningEffort, redactor),
    profile: safeLabel(metadata.profile, redactor),
    runMode: safeLabel(metadata.runMode, redactor),
    harnessDigest: metadata.harnessDigest ?? null,
    compilerDigest: metadata.compilerDigest ?? null,
    compilerActivation: "inspection_only"
  };
}

function callRequest(turn, composition, redactor) {
  const prompt = turn.model.prompt?.payload;
  const observation = prompt?.traceObservation;
  return {
    requestDigest: prompt?.requestDigest ?? null,
    toolSchemaDigest: prompt?.toolSchemaDigest ?? null,
    visibleToolNames: (observation?.visibleToolNames ?? []).map((name) => safeLabel(name, redactor)),
    visibleToolNamesAccuracy: observation ? "runtime_exact" : "unavailable",
    estimatedTokens: composition
  };
}

function callState(turn, classified) {
  const terminal = turn.states.completion ?? turn.states.suspended;
  let status = "not_terminal";
  if (turn.states.completion) status = "completed";
  else if (turn.states.suspended) status = "needs_input";
  return {
    validation: validationState(turn, classified),
    checkpoint: {
      events: turn.states.checkpointEvents.map(eventRef),
      observed: turn.states.checkpointEvents.length > 0
    },
    completion: { status, sourceRef: eventRef(terminal) }
  };
}

function modelCall(turn, classified, metadata, redactor) {
  const classification = classified.classifications.find((item) => item.turnOrdinal === turn.ordinal);
  const usage = tokenUsageAttribution(turn.model.usage);
  const composition = requestComposition(turn.model.prompt);
  return {
    callId: `model-turn-${turn.ordinal}`,
    ordinal: turn.ordinal,
    modelTurnId: turn.turnId,
    startRef: turn.startRef,
    completionRef: eventRef(turn.model.completion ?? turn.model.failure),
    configuration: callConfiguration(turn, metadata, redactor),
    request: callRequest(turn, composition, redactor),
    usage,
    uncachedProxyAttribution: proxyAttribution(usage, composition),
    toolCallCount: turn.calls.length,
    toolResults: callToolResults(turn),
    latency: modelLatency(turn),
    mutationFrontierRevision: turn.mutationFrontierRevision,
    state: callState(turn, classified),
    classification
  };
}

function terminalState(indexed, metadata) {
  const terminal = lastEvent(indexed.events, (event) => [
    "run.completed", "run.suspended", "run.cancelled", "run.failed"
  ].includes(event.type));
  const timeout = Boolean(metadata.timeout) || indexed.events.some((event) =>
    event.type === "model.failed" && event.payload?.diagnostics?.category === "timeout");
  const statuses = {
    "run.completed": "completed",
    "run.suspended": "needs_input",
    "run.cancelled": "cancelled",
    "run.failed": "failed"
  };
  const finalStatus = statuses[terminal?.type] ?? safeLabel(metadata.finalStatus ?? "incomplete", metadata.redactor);
  const infrastructureFailure = Boolean(metadata.infrastructureFailure);
  return {
    finalStatus,
    timeout,
    infrastructureFailure,
    successful: finalStatus === "completed" && !timeout && !infrastructureFailure,
    successDefinition: "product_terminal_completed_without_timeout_or_infrastructure_failure",
    terminalRef: eventRef(terminal)
  };
}

function sumKnown(values) {
  const known = values.filter(Number.isFinite);
  return { value: known.reduce((total, value) => total + value, 0), observedCount: known.length };
}

function sumComponents(calls, selector) {
  const names = ["systemBaseContext", "toolSchema", "conversationHistory", "toolResults", "modelOutput"];
  return Object.fromEntries(names.map((name) => [name, sumKnown(calls.map((call) => selector(call)?.[name]))]));
}

function primaryTurnTotals(calls) {
  const names = [...new Set(calls.map((call) => call.classification.primary))].sort();
  return Object.fromEntries(names.map((name) => {
    const selected = calls.filter((call) => call.classification.primary === name);
    return [name, {
      turns: selected.length,
      uncachedTokenProxy: sumKnown(selected.map((call) => call.usage.uncachedInputPlusOutputV1.value))
    }];
  }));
}

function attemptTotals(calls, classified) {
  const results = calls.flatMap((call) => call.toolResults);
  return {
    modelTurns: calls.length,
    turnCategories: Object.fromEntries(Object.entries(classified.categories)
      .map(([name, value]) => [name, value.count])),
    toolCalls: calls.reduce((total, call) => total + call.toolCallCount, 0),
    repeatedToolCalls: classified.repeats.toolCalls.length,
    repeatedObservations: classified.repeats.observations.length,
    repeatedReads: classified.repeats.reads.length,
    repeatedValidations: classified.repeats.validations.length,
    uncachedTokenProxy: sumKnown(calls.map((call) => call.usage.uncachedInputPlusOutputV1.value)),
    providerCacheReadTokens: sumKnown(calls.map((call) => call.usage.providerReported.cacheReadTokens)),
    toolOutputRawBytes: sumKnown(results.map((result) => result.rawBytes)),
    toolOutputModelVisibleBytes: sumKnown(results.map((result) => result.modelVisibleBytes)),
    estimatedRequestComposition: sumComponents(calls, (call) => call.request.estimatedTokens),
    proxyCostAttribution: sumComponents(calls, (call) => call.uncachedProxyAttribution.components),
    primaryTurnAttribution: primaryTurnTotals(calls)
  };
}

function eventByRef(indexed, ref) {
  return ref ? indexed.events.find((event) => event.eventId === ref.eventId) : null;
}

function attemptTiming(indexed, classified, metadata) {
  const started = firstEvent(indexed.events, (event) => event.type === "run.started")
    ?? indexed.events[0];
  const firstAction = eventByRef(indexed, classified.milestones.firstToolCall?.eventRef);
  const firstMutation = eventByRef(indexed, classified.milestones.firstMutation?.eventRef);
  return {
    totalLatencyMs: Number.isFinite(metadata.durationMs)
      ? Math.max(0, Math.round(metadata.durationMs))
      : elapsedMs(started, indexed.events.at(-1)),
    timeToFirstActionMs: elapsedMs(started, firstAction),
    timeToFirstMutationMs: elapsedMs(started, firstMutation),
    completionTailMs: classified.completionTail.latencyMs
  };
}

function attemptSummary(report, metadata) {
  return {
    attemptId: report.attemptId,
    scenarioId: metadata.scenarioId,
    repetition: metadata.repetition,
    successful: report.terminal.successful,
    finalStatus: report.terminal.finalStatus,
    timeout: report.terminal.timeout,
    infrastructureFailure: report.terminal.infrastructureFailure,
    totals: report.totals,
    timing: report.timing,
    completionTailTurns: report.derived.completionTail.count,
    reportDigest: report.reportDigest
  };
}

function traceSource(indexed, metadata) {
  return {
    eventStreamDigest: digest(indexed.events),
    firstEventRef: eventRef(indexed.events[0]),
    lastEventRef: eventRef(indexed.events.at(-1)),
    harnessDigest: metadata.harnessDigest ?? null,
    compilerDigest: metadata.compilerDigest ?? null,
    compilerActivation: "inspection_only"
  };
}

function traceIdentity(indexed, metadata, redactor) {
  return {
    generatedAt: indexed.events.at(-1)?.occurredAt ?? metadata.finishedAt ?? metadata.startedAt ?? null,
    attemptId: safeLabel(metadata.attemptId ?? "unknown", redactor),
    sessionId: safeLabel(metadata.sessionId ?? indexed.events[0]?.sessionId ?? "unknown", redactor)
  };
}

export function buildTraceAttribution(events, metadata = {}) {
  const redactor = metadata.redactor ?? String;
  const indexed = traceTurns(events, redactor);
  const classified = classifyTrace(indexed);
  const created = firstEvent(indexed.events, (event) => event.type === "session.created");
  const runtimeMode = created?.payload?.mode ?? metadata.runMode ?? "change";
  const normalized = { ...metadata, runMode: runtimeMode, redactor };
  const calls = indexed.turns.map((turn) => modelCall(turn, classified, normalized, redactor));
  const base = {
    $schema: TRACE_ATTRIBUTION_SCHEMA_ID,
    schemaVersion: TRACE_ATTRIBUTION_SCHEMA_VERSION,
    kind: "trace_attribution_attempt",
    attributionVersion: TRACE_ATTRIBUTION_VERSION,
    ...traceIdentity(indexed, metadata, redactor),
    source: traceSource(indexed, metadata),
    modelCalls: calls,
    derived: classified,
    totals: attemptTotals(calls, classified),
    timing: attemptTiming(indexed, classified, metadata),
    terminal: terminalState(indexed, normalized)
  };
  const report = reportWithDigest(base);
  return { report, summary: attemptSummary(report, metadata) };
}

function aggregateTotals(summaries) {
  const numberAt = (summary, path) => path.reduce((value, key) => value?.[key], summary);
  const sum = (path) => summaries.reduce((total, summary) => total + (numberAt(summary, path) ?? 0), 0);
  const categories = ["inspect", "mutation", "validation", "recovery", "user_input", "completion_tail"];
  const finalStatuses = [...new Set(summaries.map((item) => item.finalStatus))].sort();
  return {
    attempts: summaries.length,
    successfulAttempts: summaries.filter((item) => item.successful).length,
    modelTurns: sum(["totals", "modelTurns"]),
    toolCalls: sum(["totals", "toolCalls"]),
    repeatedToolCalls: sum(["totals", "repeatedToolCalls"]),
    repeatedObservations: sum(["totals", "repeatedObservations"]),
    repeatedReads: sum(["totals", "repeatedReads"]),
    repeatedValidations: sum(["totals", "repeatedValidations"]),
    turnCategories: Object.fromEntries(categories.map((name) => [name, sum(["totals", "turnCategories", name])])),
    uncachedTokenProxy: sum(["totals", "uncachedTokenProxy", "value"]),
    providerCacheReadTokens: sum(["totals", "providerCacheReadTokens", "value"]),
    toolOutputRawBytes: sum(["totals", "toolOutputRawBytes", "value"]),
    toolOutputModelVisibleBytes: sum(["totals", "toolOutputModelVisibleBytes", "value"]),
    completionTailTurns: sum(["completionTailTurns"]),
    timeouts: summaries.filter((item) => item.timeout).length,
    infrastructureFailures: summaries.filter((item) => item.infrastructureFailure).length,
    finalStatuses: Object.fromEntries(finalStatuses.map((status) => [
      status, summaries.filter((item) => item.finalStatus === status).length
    ]))
  };
}

function successfulDistributions(summaries) {
  const successful = summaries.filter((item) => item.successful);
  return {
    uncachedTokenProxy: distribution(successful.map((item) => item.totals.uncachedTokenProxy.value)),
    modelTurns: distribution(successful.map((item) => item.totals.modelTurns)),
    totalLatencyMs: distribution(successful.map((item) => item.timing.totalLatencyMs))
  };
}

function timingDistributions(summaries) {
  return {
    timeToFirstActionMs: distribution(summaries.map((item) => item.timing.timeToFirstActionMs)),
    timeToFirstMutationMs: distribution(summaries.map((item) => item.timing.timeToFirstMutationMs)),
    completionTailMs: distribution(summaries.map((item) => item.timing.completionTailMs))
  };
}

function aggregateComponents(summaries, key) {
  const names = ["systemBaseContext", "toolSchema", "conversationHistory", "toolResults", "modelOutput"];
  return Object.fromEntries(names.map((name) => [name, summaries.reduce((total, summary) =>
    total + (summary.totals[key]?.[name]?.value ?? 0), 0)]));
}

function scenarioAggregates(summaries) {
  const ids = [...new Set(summaries.map((item) => item.scenarioId))].sort();
  return ids.map((scenarioId) => {
    const selected = summaries.filter((item) => item.scenarioId === scenarioId);
    return {
      scenarioId,
      totals: aggregateTotals(selected),
      successfulDistributions: successfulDistributions(selected),
      timingDistributions: timingDistributions(selected)
    };
  });
}

export function buildAggregateTraceAttribution(summaries, metadata = {}) {
  const ordered = [...summaries].sort((left, right) =>
    String(left.scenarioId).localeCompare(String(right.scenarioId)) || left.repetition - right.repetition);
  return reportWithDigest({
    $schema: TRACE_ATTRIBUTION_SCHEMA_ID,
    schemaVersion: TRACE_ATTRIBUTION_SCHEMA_VERSION,
    kind: "trace_attribution_aggregate",
    attributionVersion: TRACE_ATTRIBUTION_VERSION,
    runId: metadata.runId ?? null,
    generatedAt: metadata.finishedAt ?? null,
    configuration: {
      provider: metadata.provider ?? null,
      model: metadata.model ?? null,
      reasoningEffort: metadata.reasoningEffort ?? null,
      profile: metadata.profile ?? null,
      runMode: metadata.runMode ?? "change"
    },
    totals: aggregateTotals(ordered),
    tokenCostAttribution: aggregateComponents(ordered, "proxyCostAttribution"),
    estimatedRequestComposition: aggregateComponents(ordered, "estimatedRequestComposition"),
    successfulAttemptDistributions: successfulDistributions(ordered),
    timingDistributions: timingDistributions(ordered),
    scenarios: scenarioAggregates(ordered),
    attempts: ordered
  });
}

function markdownTable(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function renderAttemptTraceMarkdown(report) {
  const categoryRows = Object.entries(report.totals.turnCategories)
    .map(([name, count]) => [name, String(count)]);
  return [
    "# Trace attribution",
    "",
    `- Attempt: \`${report.attemptId}\``,
    `- Final status: ${report.terminal.finalStatus}`,
    `- Model turns: ${report.totals.modelTurns}`,
    `- Tool calls / repeated: ${report.totals.toolCalls} / ${report.totals.repeatedToolCalls}`,
    `- Uncached token proxy: ${report.totals.uncachedTokenProxy.value}`,
    `- Completion tail turns: ${report.derived.completionTail.count}`,
    "",
    "| Turn class | Count |",
    "| --- | ---: |",
    markdownTable(categoryRows),
    "",
    `Authoritative JSON digest: \`${report.reportDigest}\``,
    ""
  ].join("\n");
}

export function renderAggregateTraceMarkdown(report) {
  const componentRows = Object.entries(report.tokenCostAttribution)
    .sort(([, left], [, right]) => right - left)
    .map(([name, value]) => [name, String(value)]);
  return [
    "# Aggregate trace attribution",
    "",
    `- Attempts / successful product terminals: ${report.totals.attempts} / ${report.totals.successfulAttempts}`,
    `- Model turns: ${report.totals.modelTurns}`,
    `- Tool calls / repeated: ${report.totals.toolCalls} / ${report.totals.repeatedToolCalls}`,
    `- Uncached token proxy: ${report.totals.uncachedTokenProxy}`,
    `- Completion tail turns: ${report.totals.completionTailTurns}`,
    "",
    "| Proxy token component | Tokens |",
    "| --- | ---: |",
    markdownTable(componentRows),
    "",
    `Authoritative JSON digest: \`${report.reportDigest}\``,
    ""
  ].join("\n");
}

export async function writeAttemptTraceAttribution(directory, report, redactor = String) {
  const jsonPath = path.join(directory, "trace-attribution.json");
  const markdownPath = path.join(directory, "trace-attribution.md");
  await writeJson(jsonPath, report, redactor);
  await writeFile(markdownPath, redactor(renderAttemptTraceMarkdown(report)), "utf8");
  return { jsonPath, markdownPath };
}

export async function writeAggregateTraceAttribution(runDir, report, redactor = String) {
  const jsonPath = path.join(runDir, "trace-attribution.json");
  const markdownPath = path.join(runDir, "trace-attribution.md");
  await writeJson(jsonPath, report, redactor);
  await writeFile(markdownPath, redactor(renderAggregateTraceMarkdown(report)), "utf8");
  return { jsonPath, markdownPath };
}
