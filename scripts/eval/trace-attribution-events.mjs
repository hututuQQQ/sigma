import { digest } from "./common.mjs";
import {
  canonicalArgumentsDigest,
  eventRef,
  readScopeDigest,
  safeLabel
} from "./trace-attribution-schema.mjs";

const MUTATION_EFFECTS = new Set([
  "filesystem.write", "repository.write", "checkpoint.restore", "destructive"
]);

function eventTimestamp(event) {
  const value = Date.parse(event?.occurredAt ?? "");
  return Number.isFinite(value) ? value : null;
}

export function elapsedMs(start, end) {
  const left = eventTimestamp(start);
  const right = eventTimestamp(end);
  return left === null || right === null ? null : Math.max(0, right - left);
}

function changedDelta(delta) {
  return delta && [delta.added, delta.modified, delta.deleted]
    .some((items) => Array.isArray(items) && items.length > 0);
}

function evidenceMutates(payload) {
  if (payload?.kind === "repository_delta") return true;
  if (payload?.kind === "checkpoint" && payload.data?.sourceSessionId) return true;
  return payload?.kind === "diagnostic"
    && payload.data?.source === "enclosing_container_mutation"
    && Array.isArray(payload.data?.diagnostic?.declaredPaths)
    && payload.data.diagnostic.declaredPaths.length > 0;
}

export function mutationEvent(event) {
  if (event.type === "checkpoint.restored") return true;
  if (event.type === "checkpoint.sealed") {
    return event.payload?.delta === undefined || changedDelta(event.payload.delta);
  }
  return event.type === "evidence.recorded" && evidenceMutates(event.payload);
}

export function mutationTimeline(events) {
  const before = new Map();
  const after = new Map();
  let revision = 0;
  for (const event of events) {
    before.set(event.eventId, revision);
    if (mutationEvent(event)) revision += 1;
    after.set(event.eventId, revision);
  }
  return { before, after, finalRevision: revision };
}

function eventWindows(events) {
  const starts = events.map((event, index) => ({ event, index }))
    .filter((item) => item.event.type === "model.started");
  return starts.map((item, ordinal) => ({
    ordinal: ordinal + 1,
    start: item.event,
    nextStart: starts[ordinal + 1]?.event ?? null,
    events: events.slice(item.index, starts[ordinal + 1]?.index ?? events.length)
  }));
}

function effectsForCall(call, windowEvents, executionPlans) {
  const planned = executionPlans.get(call.payload.callId)?.payload?.plan?.exactEffects ?? [];
  const receipt = windowEvents.find((event) => ["tool.completed", "tool.failed"].includes(event.type)
    && event.payload?.callId === call.payload.callId);
  return {
    effects: [...new Set([
      ...planned,
      ...(receipt?.payload?.observedEffects ?? []),
      ...(receipt?.payload?.actualEffects ?? [])
    ])].sort(),
    receipt
  };
}

function artifactDigests(payload, outputDigest) {
  const refs = (payload?.artifactRefs ?? [])
    .filter((item) => typeof item?.digest === "string")
    .map((item) => ({ digest: item.digest, source: "artifact_ref" }));
  return refs.length > 0 ? refs : [{ digest: outputDigest, source: "durable_full_output" }];
}

function receiptObservation(payload, output) {
  const observed = payload?.traceObservation ?? {};
  const rawBytes = Buffer.byteLength(output, "utf8");
  const fullOutputDigest = digest(output);
  return {
    rawBytes,
    rawBytesAccuracy: "durable_exact",
    modelVisibleBytes: Number.isSafeInteger(observed.modelVisibleBytes)
      ? observed.modelVisibleBytes : null,
    fullOutputDigest,
    observationIntegrity: observed.schemaVersion === 1
      ? observed.rawBytes === rawBytes && observed.fullOutputDigest === fullOutputDigest
      : "unavailable",
    modelVisibleBytesAccuracy: Number.isSafeInteger(observed.modelVisibleBytes)
      ? "runtime_exact" : "unavailable"
  };
}

function toolResult(receipt, redactor) {
  if (!receipt) return null;
  const output = typeof receipt.payload?.output === "string" ? receipt.payload.output : "";
  const observation = receiptObservation(receipt.payload, output);
  return {
    status: receipt.type === "tool.completed" ? "completed" : "failed",
    ...observation,
    fullArtifactDigests: artifactDigests(receipt.payload, observation.fullOutputDigest)
      .map((item) => ({ ...item, digest: safeLabel(item.digest, redactor) })),
    durationMs: elapsedMs(
      { occurredAt: receipt.payload?.startedAt },
      { occurredAt: receipt.payload?.completedAt }
    ),
    eventRef: eventRef(receipt)
  };
}

function toolCallRecord(call, windowEvents, executionPlans, timeline, redactor) {
  const { effects, receipt } = effectsForCall(call, windowEvents, executionPlans);
  const name = safeLabel(call.payload?.name, redactor);
  const argumentsValue = call.payload?.arguments ?? {};
  const revision = timeline.before.get(call.eventId) ?? 0;
  const validation = effects.includes("validation") || name === "validate";
  return {
    callId: safeLabel(call.payload?.callId, redactor),
    toolName: name,
    canonicalArgumentsDigest: canonicalArgumentsDigest(argumentsValue, redactor),
    readScopeDigest: effects.some((effect) => effect.startsWith("filesystem.read"))
      ? readScopeDigest(argumentsValue, redactor) : null,
    mutationFrontierRevision: revision,
    effects,
    mutationPlannedOrObserved: effects.some((effect) => MUTATION_EFFECTS.has(effect)),
    validation,
    requestedRef: eventRef(call),
    result: toolResult(receipt, redactor)
  };
}

function windowStates(windowEvents) {
  const validationEvents = windowEvents.filter((event) => event.type === "evidence.recorded"
    && event.payload?.kind === "validation");
  const checkpointEvents = windowEvents.filter((event) => event.type.startsWith("checkpoint."));
  const completion = windowEvents.find((event) => event.type === "run.completed");
  const suspended = windowEvents.find((event) => event.type === "run.suspended");
  return {
    validationEvents,
    checkpointEvents,
    completion,
    suspended
  };
}

function modelEvents(windowEvents, turnId) {
  const completion = windowEvents.find((event) => event.type === "model.completed"
    && event.payload?.turnId === turnId);
  const failure = windowEvents.find((event) => event.type === "model.failed"
    && event.payload?.turnId === turnId);
  const prompt = windowEvents.find((event) => event.type === "model.prompt_materialized"
    && event.payload?.turnId === turnId);
  const usage = completion?.payload?.usage ?? windowEvents.find((event) => event.type === "usage.recorded"
    && String(event.payload?.requestId ?? "").endsWith(`:${turnId}`))?.payload;
  return { completion, failure, prompt, usage };
}

function windowEndEvent(windowEvents) {
  return windowEvents.findLast((event) => [
    "run.completed", "run.cancelled", "run.failed", "run.suspended"
  ].includes(event.type)) ?? windowEvents.at(-1);
}

export function traceTurns(events, redactor = String) {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const timeline = mutationTimeline(ordered);
  const executionPlans = new Map(ordered.filter((event) => event.type === "execution.planned")
    .map((event) => [event.payload?.toolCallId, event]));
  const turns = eventWindows(ordered).map((window) => {
    const turnId = window.start.payload?.turnId;
    const calls = window.events.filter((event) => event.type === "tool.requested")
      .map((call) => toolCallRecord(call, window.events, executionPlans, timeline, redactor));
    const model = modelEvents(window.events, turnId);
    const states = windowStates(window.events);
    const last = windowEndEvent(window.events);
    return {
      ordinal: window.ordinal,
      turnId,
      startRef: eventRef(window.start),
      endRef: eventRef(last),
      startEvent: window.start,
      boundaryEvent: window.nextStart ?? last,
      events: window.events,
      model,
      calls,
      states,
      mutationFrontierRevision: {
        start: timeline.before.get(window.start.eventId) ?? 0,
        end: timeline.after.get(last?.eventId) ?? timeline.finalRevision
      }
    };
  });
  return { events: ordered, turns, timeline };
}

export function firstEvent(events, predicate) {
  return events.find(predicate) ?? null;
}

export function lastEvent(events, predicate) {
  return events.findLast(predicate) ?? null;
}
