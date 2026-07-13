import { createHash } from "node:crypto";

const TERMINAL_TYPES = new Set(["run.completed", "run.cancelled", "run.failed", "run.suspended"]);
const AGENT_ACTION_TYPES = new Set([
  "model.started", "model.completed", "model.failed", "tool.requested", "tool.started",
  "tool.completed", "tool.failed", "execution.started", "execution.completed", "execution.failed"
]);
const WORK_TYPES = new Set(["model.started", "tool.requested", "context.compacted"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestamp(event) {
  const value = Date.parse(event.occurredAt);
  return Number.isFinite(value) ? value : 0;
}

function elapsed(start, end) {
  return start > 0 && end >= start ? end - start : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestIdentity(event) {
  const payload = record(event.payload);
  const name = typeof payload.name === "string" ? payload.name : "unknown";
  const serialized = canonical(payload.arguments ?? null);
  return { name, hash: digest(`${name}\0${serialized}`) };
}

function outputIdentity(event) {
  const payload = record(event.payload);
  if (typeof payload.output !== "string") return null;
  const bytes = Buffer.byteLength(payload.output);
  return { name: typeof payload.name === "string" ? payload.name : "unknown", hash: digest(payload.output), bytes };
}

function sortedEvents(input) {
  return [...input].sort((left, right) => left.seq - right.seq);
}

function terminalSummary(events) {
  const event = [...events].reverse().find((item) => TERMINAL_TYPES.has(item.type));
  if (!event) return { status: "incomplete", type: null, seq: null, occurredAt: null, code: null };
  const payload = record(event.payload);
  const status = {
    "run.completed": "completed",
    "run.cancelled": "cancelled",
    "run.failed": "failed",
    "run.suspended": "needs_input"
  }[event.type];
  return {
    status,
    type: event.type,
    seq: event.seq,
    occurredAt: event.occurredAt,
    code: typeof payload.code === "string" ? payload.code : null
  };
}

function eventCounts(events) {
  const byType = {};
  for (const event of events) byType[event.type] = (byType[event.type] ?? 0) + 1;
  const toolCalls = byType["tool.requested"] ?? 0;
  const toolFailures = byType["tool.failed"] ?? 0;
  return {
    totalEvents: events.length,
    byType,
    modelTurns: byType["model.started"] ?? 0,
    modelCompletions: byType["model.completed"] ?? 0,
    modelFailures: byType["model.failed"] ?? 0,
    toolCalls,
    toolCompletions: byType["tool.completed"] ?? 0,
    toolFailures,
    toolFailureRate: toolCalls === 0 ? 0 : toolFailures / toolCalls,
    approvals: byType["tool.approval_requested"] ?? 0,
    approvalResolutions: byType["tool.approval_resolved"] ?? 0,
    contextCompactions: byType["context.compacted"] ?? 0,
    userMessages: (byType["user.message"] ?? 0) + (byType["user.follow_up"] ?? 0),
    steers: byType["user.steer"] ?? 0
  };
}

function toolCounts(events) {
  const tools = {};
  for (const event of events) {
    if (!["tool.requested", "tool.completed", "tool.failed"].includes(event.type)) continue;
    const payload = record(event.payload);
    const name = typeof payload.name === "string" ? payload.name : "unknown";
    const entry = tools[name] ?? { requested: 0, completed: 0, failed: 0 };
    if (event.type === "tool.requested") entry.requested += 1;
    if (event.type === "tool.completed") entry.completed += 1;
    if (event.type === "tool.failed") entry.failed += 1;
    tools[name] = entry;
  }
  return Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)));
}

function usageTotals(events) {
  const totals = {
    records: 0, attempts: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0, costUsd: 0,
    latencyMs: 0, providerReportedRecords: 0,
    reviewer: { records: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, latencyMs: 0 }
  };
  for (const event of events) {
    if (event.type !== "usage.recorded") continue;
    const usage = record(event.payload);
    totals.records += 1;
    totals.attempts += Math.max(1, number(usage.attempt));
    totals.inputTokens += number(usage.inputTokens);
    totals.outputTokens += number(usage.outputTokens);
    totals.reasoningTokens += number(usage.reasoningTokens);
    totals.cacheReadTokens += number(usage.cacheReadTokens);
    totals.cacheWriteTokens += number(usage.cacheWriteTokens);
    totals.costMicroUsd += number(usage.costMicroUsd);
    totals.latencyMs += number(usage.latencyMs);
    if (usage.providerReported === true) totals.providerReportedRecords += 1;
    if (usage.role === "reviewer") {
      totals.reviewer.records += 1;
      totals.reviewer.inputTokens += number(usage.inputTokens);
      totals.reviewer.outputTokens += number(usage.outputTokens);
      totals.reviewer.costMicroUsd += number(usage.costMicroUsd);
      totals.reviewer.latencyMs += number(usage.latencyMs);
    }
  }
  totals.costUsd = totals.costMicroUsd / 1_000_000;
  return totals;
}

function groupRepeatedRequests(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.type !== "tool.requested") continue;
    const identity = requestIdentity(event);
    const group = groups.get(identity.hash) ?? {
      fingerprint: identity.hash, name: identity.name, count: 0, firstSeq: event.seq, lastSeq: event.seq
    };
    group.count += 1;
    group.lastSeq = event.seq;
    groups.set(identity.hash, group);
  }
  const repeatedGroups = [...groups.values()].filter((item) => item.count > 1)
    .sort((left, right) => right.count - left.count || left.firstSeq - right.firstSeq);
  const total = events.filter((event) => event.type === "tool.requested").length;
  const repeated = repeatedGroups.reduce((sum, item) => sum + item.count - 1, 0);
  return {
    total, unique: groups.size, repeated, rate: total === 0 ? 0 : repeated / total,
    groups: repeatedGroups.slice(0, 20)
  };
}

function groupRepeatedOutputs(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.type !== "tool.completed" && event.type !== "tool.failed") continue;
    const identity = outputIdentity(event);
    if (!identity) continue;
    const key = `${identity.name}\0${identity.hash}`;
    const group = groups.get(key) ?? {
      fingerprint: identity.hash, name: identity.name, bytes: identity.bytes,
      count: 0, firstSeq: event.seq, lastSeq: event.seq
    };
    group.count += 1;
    group.lastSeq = event.seq;
    groups.set(key, group);
  }
  const repeatedGroups = [...groups.values()].filter((item) => item.count > 1)
    .sort((left, right) => right.bytes * (right.count - 1) - left.bytes * (left.count - 1));
  return {
    total: [...groups.values()].reduce((sum, item) => sum + item.count, 0),
    unique: groups.size,
    repeated: repeatedGroups.reduce((sum, item) => sum + item.count - 1, 0),
    repeatedBytes: repeatedGroups.reduce((sum, item) => sum + item.bytes * (item.count - 1), 0),
    groups: repeatedGroups.slice(0, 20)
  };
}

function workspaceDeltaFrom(event) {
  const payload = record(event.payload);
  if (event.type === "evidence.recorded" && payload.kind === "workspace_delta") {
    return record(record(payload.data).delta);
  }
  if ((event.type === "tool.completed" || event.type === "tool.failed") && payload.workspaceDelta) {
    return record(payload.workspaceDelta);
  }
  return null;
}

function workspaceDeltas(events) {
  const groups = new Map();
  for (const event of events) {
    const delta = workspaceDeltaFrom(event);
    if (!delta) continue;
    const normalized = {
      added: Array.isArray(delta.added) ? delta.added.filter((item) => typeof item === "string") : [],
      modified: Array.isArray(delta.modified) ? delta.modified.filter((item) => typeof item === "string") : [],
      deleted: Array.isArray(delta.deleted) ? delta.deleted.filter((item) => typeof item === "string") : []
    };
    if (normalized.added.length + normalized.modified.length + normalized.deleted.length === 0) continue;
    const fingerprint = digest(canonical(normalized));
    if (!groups.has(fingerprint)) groups.set(fingerprint, { ...normalized, fingerprint, seq: event.seq });
  }
  const deltas = [...groups.values()].sort((left, right) => left.seq - right.seq);
  const added = [...new Set(deltas.flatMap((item) => item.added))].sort();
  const modified = [...new Set(deltas.flatMap((item) => item.modified))].sort();
  const deleted = [...new Set(deltas.flatMap((item) => item.deleted))].sort();
  return {
    count: deltas.length,
    added,
    modified,
    deleted,
    changedFiles: [...new Set([...added, ...modified, ...deleted])].sort()
  };
}

function hasEffect(payload, effect) {
  return [payload.actualEffects, payload.observedEffects]
    .some((effects) => Array.isArray(effects) && effects.includes(effect));
}

function modelToolCallName(call) {
  const value = record(call);
  return typeof value.name === "string" ? value.name : typeof record(value.function).name === "string"
    ? record(value.function).name : null;
}

function isAnswer(event) {
  if (event.type !== "model.completed") return false;
  const payload = record(event.payload);
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
  return text.length > 0 && (calls.length === 0 || calls.every((call) => modelToolCallName(call) === "complete_task"));
}

function isSubstantiveProgress(event, seenSuccessfulOutputs) {
  if (isAnswer(event) || TERMINAL_TYPES.has(event.type)) return true;
  const payload = record(event.payload);
  if (event.type === "evidence.recorded" && ["workspace_delta", "validation"].includes(String(payload.kind))) return true;
  if (event.type !== "tool.completed") return false;
  if (hasEffect(payload, "filesystem.write") || hasEffect(payload, "validation")) return true;
  const identity = outputIdentity(event);
  if (!identity) return false;
  const key = `${identity.name}\0${identity.hash}`;
  if (seenSuccessfulOutputs.has(key)) return false;
  seenSuccessfulOutputs.add(key);
  return true;
}

function stagnationWindows(events, minimumWorkUnits) {
  const windows = [];
  const seenRequests = new Set();
  const seenSuccessfulOutputs = new Set();
  let active = null;
  const finish = (endEvent) => {
    if (!active) return;
    active.endSeq = endEvent.seq;
    active.endedAt = endEvent.occurredAt;
    active.durationMs = Math.max(0, timestamp(endEvent) - active.startedMs);
    delete active.startedMs;
    if (active.workUnits >= minimumWorkUnits) windows.push(active);
    active = null;
  };
  for (const event of events) {
    if (isSubstantiveProgress(event, seenSuccessfulOutputs)) {
      finish(event);
      continue;
    }
    const isFailure = event.type === "tool.failed" || event.type === "model.failed" || event.type === "execution.failed";
    if (!WORK_TYPES.has(event.type) && !isFailure) continue;
    active ??= {
      startSeq: event.seq, endSeq: event.seq, startedAt: event.occurredAt, endedAt: event.occurredAt,
      startedMs: timestamp(event), durationMs: 0, workUnits: 0, modelTurns: 0,
      toolCalls: 0, failures: 0, compactions: 0, repeatedRequests: 0
    };
    if (event.type === "model.started") active.modelTurns += 1;
    if (event.type === "tool.requested") {
      active.toolCalls += 1;
      const identity = requestIdentity(event).hash;
      if (seenRequests.has(identity)) active.repeatedRequests += 1;
      seenRequests.add(identity);
    }
    if (event.type === "context.compacted") active.compactions += 1;
    if (isFailure) active.failures += 1;
    if (WORK_TYPES.has(event.type)) active.workUnits += 1;
    active.endSeq = event.seq;
    active.endedAt = event.occurredAt;
  }
  if (active) finish(events.at(-1) ?? { seq: active.endSeq, occurredAt: active.endedAt });
  return windows.sort((left, right) => right.workUnits - left.workUnits || right.durationMs - left.durationMs).slice(0, 20);
}

function postAnswerChurn(events) {
  const lastFollowUp = events.reduce((latest, event, index) =>
    event.type === "user.follow_up" ? index : latest, -1);
  const relativeAnswerIndex = events.slice(lastFollowUp + 1).findIndex(isAnswer);
  const answerIndex = relativeAnswerIndex < 0 ? -1 : lastFollowUp + 1 + relativeAnswerIndex;
  if (answerIndex < 0) {
    return { answerSeq: null, answeredAt: null, events: 0, modelTurns: 0, toolCalls: 0, durationMs: 0 };
  }
  const answer = events[answerIndex];
  const later = events.slice(answerIndex + 1);
  const completionIds = new Set((Array.isArray(record(answer.payload).toolCalls) ? record(answer.payload).toolCalls : [])
    .filter((call) => modelToolCallName(call) === "complete_task")
    .flatMap((call) => {
      const value = record(call);
      const identity = value.id ?? value.callId;
      return typeof identity === "string" ? [identity] : [];
    }));
  const finalizationEvent = (event) => {
    const payload = record(event.payload);
    const identity = typeof payload.callId === "string" ? payload.callId
      : typeof payload.executionId === "string" ? payload.executionId : null;
    return identity !== null && completionIds.has(identity);
  };
  const churn = later.filter((event) => (AGENT_ACTION_TYPES.has(event.type) || event.type === "context.compacted")
    && !finalizationEvent(event));
  const last = churn.at(-1);
  return {
    answerSeq: answer.seq,
    answeredAt: answer.occurredAt,
    events: churn.length,
    modelTurns: churn.filter((event) => event.type === "model.started").length,
    toolCalls: churn.filter((event) => event.type === "tool.requested").length,
    durationMs: last ? Math.max(0, timestamp(last) - timestamp(answer)) : 0
  };
}

function effectRevision(event) {
  const value = record(event.payload).effectRevision;
  return Number.isSafeInteger(value) ? value : null;
}

function actionCorrelation(events) {
  const revisions = new Map();
  for (const event of events) {
    const payload = record(event.payload);
    const revision = effectRevision(event);
    const callId = typeof payload.callId === "string" ? payload.callId : null;
    const executionId = typeof payload.executionId === "string" ? payload.executionId : null;
    if (callId && revision !== null) revisions.set(callId, revision);
    if (executionId && revision !== null) revisions.set(executionId, revision);
    if (executionId && callId && revisions.has(callId)) revisions.set(executionId, revisions.get(callId));
  }
  return revisions;
}

function correlatedRevision(event, revisions) {
  const direct = effectRevision(event);
  if (direct !== null) return direct;
  const payload = record(event.payload);
  const identity = typeof payload.callId === "string" ? payload.callId
    : typeof payload.executionId === "string" ? payload.executionId : null;
  return identity && revisions.has(identity) ? revisions.get(identity) : null;
}

function actionIdentity(event) {
  const payload = record(event.payload);
  if (typeof payload.callId === "string") return `work:${payload.callId}`;
  if (typeof payload.executionId === "string") return `work:${payload.executionId}`;
  if (Number.isSafeInteger(payload.turnId)) return `model:${payload.turnId}`;
  return `event:${event.seq}`;
}

function steerMetrics(events) {
  const steers = [];
  const revisions = actionCorrelation(events);
  for (let index = 0; index < events.length; index += 1) {
    const steer = events[index];
    if (steer.type !== "user.steer") continue;
    const priorRevision = events.slice(0, index).reduce((highest, event) => {
      const revision = effectRevision(event);
      return revision === null ? highest : Math.max(highest, revision);
    }, -1);
    const until = events.slice(index + 1).findIndex((event) => event.type === "user.steer" || TERMINAL_TYPES.has(event.type));
    const candidates = until < 0 ? events.slice(index + 1) : events.slice(index + 1, index + 1 + until);
    const actions = candidates.filter((event) => AGENT_ACTION_TYPES.has(event.type));
    const stale = actions.filter((event) => {
      const revision = correlatedRevision(event, revisions);
      return revision !== null && priorRevision >= 0 && revision <= priorRevision;
    });
    const fresh = actions.find((event) => {
      const revision = correlatedRevision(event, revisions);
      return revision !== null && revision > priorRevision;
    });
    const staleActions = new Set(stale.map(actionIdentity));
    const staleToolCalls = new Set(stale.flatMap((event) => {
      const payload = record(event.payload);
      const identity = typeof payload.callId === "string" ? payload.callId
        : typeof payload.executionId === "string" ? payload.executionId : null;
      return identity ? [identity] : [];
    }));
    steers.push({
      seq: steer.seq,
      occurredAt: steer.occurredAt,
      priorEffectRevision: priorRevision >= 0 ? priorRevision : null,
      staleActions: staleActions.size,
      staleToolCalls: staleToolCalls.size,
      stopDelayMs: stale.length === 0 ? 0 : Math.max(0, timestamp(stale.at(-1)) - timestamp(steer)),
      firstFreshActionMs: fresh ? Math.max(0, timestamp(fresh) - timestamp(steer)) : null
    });
  }
  return {
    count: steers.length,
    staleActions: steers.reduce((sum, item) => sum + item.staleActions, 0),
    staleToolCalls: steers.reduce((sum, item) => sum + item.staleToolCalls, 0),
    maxStopDelayMs: steers.reduce((maximum, item) => Math.max(maximum, item.stopDelayMs), 0),
    events: steers
  };
}

function failureStreaks(events) {
  const streaks = [];
  let active = null;
  const finish = () => {
    if (!active) return;
    streaks.push({
      ...active,
      tools: Object.fromEntries([...active.tools.entries()].sort(([left], [right]) => left.localeCompare(right)))
    });
    active = null;
  };
  for (const event of events) {
    if (event.type !== "tool.completed" && event.type !== "tool.failed") continue;
    if (event.type === "tool.completed") {
      finish();
      continue;
    }
    const payload = record(event.payload);
    active ??= {
      startSeq: event.seq,
      endSeq: event.seq,
      startedAt: event.occurredAt,
      endedAt: event.occurredAt,
      durationMs: 0,
      count: 0,
      tools: new Map()
    };
    const name = typeof payload.name === "string" ? payload.name : "unknown";
    active.count += 1;
    active.endSeq = event.seq;
    active.endedAt = event.occurredAt;
    active.durationMs = Math.max(0, timestamp(event) - timestamp({ occurredAt: active.startedAt }));
    active.tools.set(name, (active.tools.get(name) ?? 0) + 1);
  }
  finish();
  const ordered = streaks.sort((left, right) => right.count - left.count || right.durationMs - left.durationMs);
  return {
    longest: ordered[0]?.count ?? 0,
    streaks: ordered.slice(0, 20)
  };
}

function approvalTiming(events) {
  const requested = new Map();
  const waits = [];
  for (const event of events) {
    if (event.type !== "tool.approval_requested" && event.type !== "tool.approval_resolved") continue;
    const payload = record(event.payload);
    const requestId = String(payload.requestId ?? payload.callId ?? "");
    if (!requestId) continue;
    if (event.type === "tool.approval_requested") requested.set(requestId, event);
    else if (requested.has(requestId)) {
      const start = requested.get(requestId);
      waits.push(Math.max(0, timestamp(event) - timestamp(start)));
      requested.delete(requestId);
    }
  }
  return {
    resolved: waits.length,
    unresolved: requested.size,
    totalWaitMs: waits.reduce((sum, value) => sum + value, 0),
    maxWaitMs: waits.reduce((maximum, value) => Math.max(maximum, value), 0)
  };
}

function timing(events, durationMs) {
  const anchor = events.find((event) => event.type === "user.message" || event.type === "user.follow_up")
    ?? events.find((event) => event.type === "run.started") ?? events[0];
  const visible = events.find((event) => (event.type === "model.delta" && String(record(event.payload).delta ?? "").length > 0)
    || isAnswer(event));
  const successfulTool = events.find((event) => event.type === "tool.completed");
  const mutation = events.find((event) => Boolean(workspaceDeltaFrom(event))
    || (event.type === "tool.completed" && hasEffect(record(event.payload), "filesystem.write")));
  const validation = events.find((event) => (event.type === "evidence.recorded" && record(event.payload).kind === "validation")
    || (event.type === "tool.completed" && hasEffect(record(event.payload), "validation")));
  const start = anchor ? timestamp(anchor) : 0;
  return {
    firstVisibleResponseMs: visible ? elapsed(start, timestamp(visible)) : null,
    firstSuccessfulToolMs: successfulTool ? elapsed(start, timestamp(successfulTool)) : null,
    firstMutationMs: mutation ? elapsed(start, timestamp(mutation)) : null,
    firstValidationMs: validation ? elapsed(start, timestamp(validation)) : null,
    totalDurationMs: durationMs,
    approval: approvalTiming(events)
  };
}

function hardFailures(events, mode, workspace) {
  const failures = [];
  const terminal = terminalSummary(events);
  if (terminal.status === "failed") failures.push({ code: terminal.code ?? "run_failed", seq: terminal.seq });
  const deadline = events.find((event) => {
    if (event.type !== "run.failed" && event.type !== "run.cancelled") return false;
    const payload = record(event.payload);
    return /deadline|timed?\s*out|budget_exhausted/iu.test(`${payload.code ?? ""} ${payload.message ?? ""} ${payload.reason ?? ""}`);
  });
  if (deadline) failures.push({ code: "deadline_exceeded", seq: deadline.seq });
  if (mode === "analyze" && workspace.count > 0) {
    failures.push({ code: "read_only_workspace_mutation", seq: null });
  }
  return failures;
}

/**
 * Reduce validated V3 durable events to JSON-safe, content-redacted experience metrics.
 * Tool arguments and outputs are represented only by SHA-256 fingerprints.
 */
export function reduceAgentEvents(input, options = {}) {
  const allEvents = sortedEvents(input);
  const latestRunStart = allEvents.findLastIndex((event) => event.type === "run.started");
  const latestRunId = latestRunStart >= 0 ? allEvents[latestRunStart].runId : null;
  const events = latestRunStart < 0 ? allEvents : allEvents.slice(latestRunStart)
    .filter((event) => !latestRunId || event.runId === latestRunId);
  const first = events[0] ?? null;
  const last = events.at(-1) ?? null;
  const runStarted = events.find((event) => event.type === "run.started");
  const runTerminal = [...events].reverse().find((event) => TERMINAL_TYPES.has(event.type));
  const startedMs = timestamp(runStarted ?? first ?? { occurredAt: "" });
  const endedMs = timestamp(runTerminal ?? last ?? { occurredAt: "" });
  const durationMs = startedMs > 0 && endedMs >= startedMs ? endedMs - startedMs : 0;
  const mode = options.mode ?? record(runStarted?.payload).mode ?? null;
  const workspace = workspaceDeltas(events);
  const repetitions = groupRepeatedRequests(events);
  const repeatedOutputs = groupRepeatedOutputs(events);
  return {
    schemaVersion: 1,
    kind: "sigma.agent-session-metrics",
    sessionId: first?.sessionId ?? options.sessionId ?? null,
    runId: last?.runId ?? null,
    runIds: [...new Set(events.map((event) => event.runId))],
    mode,
    timestamps: {
      firstEventAt: first?.occurredAt ?? null,
      startedAt: runStarted?.occurredAt ?? first?.occurredAt ?? null,
      endedAt: runTerminal?.occurredAt ?? last?.occurredAt ?? null
    },
    durationMs,
    terminal: terminalSummary(events),
    counts: eventCounts(events),
    toolCounts: toolCounts(events),
    timing: timing(events, durationMs),
    usageTotals: usageTotals(events),
    repeatedExactRequests: repetitions,
    repeatedOutputs,
    consecutiveToolFailures: failureStreaks(events),
    stagnationWindows: stagnationWindows(events, options.stagnationMinWorkUnits ?? 5),
    workspaceDeltas: workspace,
    postAnswerChurn: postAnswerChurn(events),
    steer: steerMetrics(events),
    hardFailures: hardFailures(events, mode, workspace)
  };
}

function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "n/a";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/** Render one SessionMetricsV1 object without reproducing model/tool content. */
export function renderSessionMetricsMarkdown(metrics) {
  const lines = [
    `## Session ${metrics.sessionId ?? "unknown"}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Terminal | ${metrics.terminal.status} |`,
    `| Duration | ${formatDuration(metrics.durationMs)} |`,
    `| Model turns / failures | ${metrics.counts.modelTurns} / ${metrics.counts.modelFailures} |`,
    `| Tool calls / failures | ${metrics.counts.toolCalls} / ${metrics.counts.toolFailures} (${percent(metrics.counts.toolFailureRate)}) |`,
    `| Approvals / compactions | ${metrics.counts.approvals} / ${metrics.counts.contextCompactions} |`,
    `| Input / output tokens | ${metrics.usageTotals.inputTokens} / ${metrics.usageTotals.outputTokens} |`,
    `| Cost | $${metrics.usageTotals.costUsd.toFixed(4)} |`,
    `| Exact repeated requests | ${metrics.repeatedExactRequests.repeated} (${percent(metrics.repeatedExactRequests.rate)}) |`,
    `| Repeated output bytes | ${metrics.repeatedOutputs.repeatedBytes} |`,
    `| Longest tool-failure streak | ${metrics.consecutiveToolFailures.longest} |`,
    `| Workspace delta files | ${metrics.workspaceDeltas.changedFiles.length} |`,
    `| Post-answer tool calls | ${metrics.postAnswerChurn.toolCalls} |`,
    `| Stale actions after steer | ${metrics.steer.staleActions} |`,
    ""
  ];
  if (metrics.stagnationWindows.length > 0) {
    lines.push("### Worst stagnation windows", "", "| Seq | Duration | Work | Tools | Failures | Repeats |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const item of metrics.stagnationWindows.slice(0, 5)) {
      lines.push(`| ${item.startSeq}-${item.endSeq} | ${formatDuration(item.durationMs)} | ${item.workUnits} | ${item.toolCalls} | ${item.failures} | ${item.repeatedRequests} |`);
    }
    lines.push("");
  }
  if (metrics.hardFailures.length > 0) {
    lines.push("### Hard failures", "", ...metrics.hardFailures.map((item) => `- ${item.code}${item.seq ? ` (seq ${item.seq})` : ""}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
