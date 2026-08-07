import { eventRef } from "./trace-attribution-schema.mjs";
import { elapsedMs, mutationEvent } from "./trace-attribution-events.mjs";

const FAILURE_TYPES = new Set(["model.failed", "tool.failed", "execution.failed", "process.lost"]);

function failedEvent(event) {
  return FAILURE_TYPES.has(event.type)
    || (event.type === "process.exited" && event.payload?.exitCode !== 0);
}

function explicitRecovery(event) {
  return event.type === "diagnostic" && (
    String(event.payload?.kind ?? "").startsWith("recovery.")
    || ["runtime.dependency_prepared", "runtime.dependency_reprobed"].includes(event.payload?.kind)
  );
}

function refs(events) {
  return events.map(eventRef).filter(Boolean);
}

function uniqueRefs(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || seen.has(item.eventId)) return false;
    seen.add(item.eventId);
    return true;
  });
}

function baseClassification(turn, prior) {
  const mutationRefs = refs(turn.events.filter(mutationEvent));
  const validationRefs = uniqueRefs([
    ...turn.calls.filter((call) => call.validation).map((call) => call.requestedRef),
    ...refs(turn.states.validationEvents)
  ]);
  const recoveryRefs = uniqueRefs([
    ...refs(turn.events.filter(explicitRecovery)),
    ...refs(prior?.events.filter(failedEvent) ?? [])
  ]);
  const userRefs = uniqueRefs([
    ...refs(turn.events.filter((event) => event.type === "run.suspended")),
    ...turn.calls.filter((call) => call.effects.includes("outcome.request_input"))
      .map((call) => call.requestedRef)
  ]);
  const mutation = turn.mutationFrontierRevision.end > turn.mutationFrontierRevision.start;
  const validation = validationRefs.length > 0;
  const recovery = recoveryRefs.length > 0;
  const userInput = userRefs.length > 0;
  const inspect = turn.calls.length > 0 && !mutation && !validation && !userInput;
  return { mutation, mutationRefs, validation, validationRefs, recovery, recoveryRefs, userInput, userRefs, inspect };
}

function primaryCategory(state, turn) {
  if (state.userInput) return "user_input";
  if (state.recovery) return "recovery";
  if (state.mutation) return "mutation";
  if (state.validation) return "validation";
  if (state.inspect) return "inspect";
  if (turn.states.completion) return "completion";
  return "other";
}

function classificationRecord(turn, prior) {
  const state = baseClassification(turn, prior);
  const labels = [
    ...(state.inspect ? ["inspect"] : []),
    ...(state.mutation ? ["mutation"] : []),
    ...(state.validation ? ["validation"] : []),
    ...(state.recovery ? ["recovery"] : []),
    ...(state.userInput ? ["user_input"] : [])
  ];
  const sourceRefs = uniqueRefs([
    ...state.mutationRefs,
    ...state.validationRefs,
    ...state.recoveryRefs,
    ...state.userRefs,
    ...turn.calls.map((call) => call.requestedRef),
    eventRef(turn.states.completion)
  ]);
  return {
    turnOrdinal: turn.ordinal,
    turnId: turn.turnId,
    primary: primaryCategory(state, turn),
    labels,
    sourceRefs
  };
}

function repeatRecord(kind, current, previous, extra = {}) {
  return {
    kind,
    ...extra,
    mutationFrontierRevision: current.mutationFrontierRevision,
    previousMutationFrontierRevision: previous.mutationFrontierRevision,
    mutationIntervened: previous.mutationFrontierRevision !== current.mutationFrontierRevision,
    previousRef: previous.requestedRef ?? previous.eventRef,
    currentRef: current.requestedRef ?? current.eventRef
  };
}

function toolRepeats(turns) {
  const seen = new Map();
  const repeated = [];
  for (const turn of turns) for (const call of turn.calls) {
    const key = [call.mutationFrontierRevision, call.toolName, call.canonicalArgumentsDigest].join(":");
    const previous = seen.get(key);
    if (previous) repeated.push(repeatRecord("canonical_tool_call", call, previous, {
      toolName: call.toolName,
      canonicalArgumentsDigest: call.canonicalArgumentsDigest
    }));
    seen.set(key, call);
  }
  return repeated;
}

function readRepeats(turns) {
  const seen = new Map();
  const repeated = [];
  for (const turn of turns) for (const call of turn.calls) {
    if (!call.readScopeDigest) continue;
    const key = [call.mutationFrontierRevision, call.toolName, call.readScopeDigest].join(":");
    const previous = seen.get(key);
    if (previous) repeated.push(repeatRecord("same_path_and_range", call, previous, {
      toolName: call.toolName,
      readScopeDigest: call.readScopeDigest
    }));
    seen.set(key, call);
  }
  return repeated;
}

function observationRecords(call) {
  if (!call.result) return [];
  const digests = new Map([[call.result.fullOutputDigest, "output"]]);
  for (const artifact of call.result.fullArtifactDigests) {
    if (!digests.has(artifact.digest)) digests.set(artifact.digest, artifact.source);
  }
  return [...digests].map(([observationDigest, source]) => ({
    observationDigest,
    source,
    mutationFrontierRevision: call.mutationFrontierRevision,
    eventRef: call.result.eventRef,
    toolName: call.toolName
  }));
}

function observationRepeats(turns) {
  const seen = new Map();
  const repeated = [];
  for (const turn of turns) for (const call of turn.calls) for (const observation of observationRecords(call)) {
    const key = observation.observationDigest;
    const previous = seen.get(key);
    if (previous) repeated.push(repeatRecord("same_artifact_or_output", observation, previous, {
      toolName: observation.toolName,
      observationDigest: observation.observationDigest,
      observationSource: observation.source
    }));
    seen.set(key, observation);
  }
  return repeated;
}

function validationObservations(turn) {
  const calls = turn.calls.filter((call) => call.validation).map((call) => ({
    turnOrdinal: turn.ordinal,
    mutationFrontierRevision: call.mutationFrontierRevision,
    eventRef: call.requestedRef
  }));
  if (calls.length > 0) return calls;
  return turn.states.validationEvents.map((event) => ({
    turnOrdinal: turn.ordinal,
    mutationFrontierRevision: Number.isSafeInteger(event.payload?.data?.frontierRevision)
      ? event.payload.data.frontierRevision : turn.mutationFrontierRevision.end,
    eventRef: eventRef(event)
  }));
}

function validationRepeats(turns) {
  const seen = new Map();
  const repeats = [];
  const effective = [];
  for (const turn of turns) for (const current of validationObservations(turn)) {
    const previous = seen.get(current.mutationFrontierRevision);
    if (previous) repeats.push(repeatRecord("validation_without_new_mutation", current, previous));
    else effective.push(current);
    seen.set(current.mutationFrontierRevision, current);
  }
  return { repeats, effective, all: [...seen.values()] };
}

function turnForEvent(turns, event) {
  return event ? turns.find((turn) => turn.events.some((item) => item.eventId === event.eventId)) : null;
}

function milestone(turn, event) {
  return turn && event ? { turnOrdinal: turn.ordinal, turnId: turn.turnId, eventRef: eventRef(event) } : null;
}

function mutationMilestones(turns) {
  const items = turns.flatMap((turn) => turn.events.filter(mutationEvent)
    .map((event) => ({ turn, event })));
  return {
    firstMutation: items[0] ? milestone(items[0].turn, items[0].event) : null,
    lastMutation: items.at(-1) ? milestone(items.at(-1).turn, items.at(-1).event) : null
  };
}

function completionTail(turns, classifications, mutation, validation, completion) {
  const anchors = [mutation.lastMutation, ...validation.effective.map((item) => ({
    turnOrdinal: item.turnOrdinal,
    turnId: turns.find((turn) => turn.ordinal === item.turnOrdinal)?.turnId,
    eventRef: item.eventRef
  }))].filter(Boolean).sort((left, right) => left.eventRef.seq - right.eventRef.seq);
  const anchor = anchors.at(-1) ?? null;
  const completionTurn = completion?.turnOrdinal ?? null;
  const tail = anchor && completionTurn !== null
    ? turns.filter((turn) => turn.ordinal > anchor.turnOrdinal && turn.ordinal <= completionTurn)
    : [];
  for (const turn of tail) {
    const record = classifications.find((item) => item.turnOrdinal === turn.ordinal);
    if (record && !record.labels.includes("completion_tail")) record.labels.push("completion_tail");
  }
  return {
    anchor,
    completion,
    count: tail.length,
    turns: tail.map((turn) => ({
      turnOrdinal: turn.ordinal,
      turnId: turn.turnId,
      sourceRefs: [turn.startRef, turn.endRef].filter(Boolean)
    })),
    latencyMs: anchor && completion
      ? elapsedMs({ occurredAt: turns.find((turn) => turn.ordinal === anchor.turnOrdinal)?.events
        .find((event) => event.eventId === anchor.eventRef.eventId)?.occurredAt },
      { occurredAt: turns.find((turn) => turn.ordinal === completion.turnOrdinal)?.events
        .find((event) => event.eventId === completion.eventRef.eventId)?.occurredAt }) : null
  };
}

function categoryIndex(classifications) {
  const names = ["inspect", "mutation", "validation", "recovery", "user_input", "completion_tail"];
  return Object.fromEntries(names.map((name) => {
    const turns = classifications.filter((item) => item.labels.includes(name))
      .map((item) => ({ turnOrdinal: item.turnOrdinal, turnId: item.turnId, sourceRefs: item.sourceRefs }));
    return [name, { count: turns.length, turns }];
  }));
}

export function classifyTrace(indexed) {
  const classifications = indexed.turns.map((turn, index) => classificationRecord(turn, indexed.turns[index - 1]));
  const toolCalls = toolRepeats(indexed.turns);
  const reads = readRepeats(indexed.turns);
  const observations = observationRepeats(indexed.turns);
  const validations = validationRepeats(indexed.turns);
  const mutations = mutationMilestones(indexed.turns);
  const firstCall = indexed.turns.flatMap((turn) => turn.calls.map((call) => ({ turn, call })))[0];
  const completionEvent = indexed.events.findLast((event) => event.type === "run.completed") ?? null;
  const completionTurn = turnForEvent(indexed.turns, completionEvent);
  const finalCompletion = milestone(completionTurn, completionEvent);
  const tail = completionTail(indexed.turns, classifications, mutations, validations, finalCompletion);
  return {
    classifications,
    categories: categoryIndex(classifications),
    repeats: { toolCalls, reads, observations, validations: validations.repeats },
    milestones: {
      firstToolCall: firstCall ? {
        turnOrdinal: firstCall.turn.ordinal,
        turnId: firstCall.turn.turnId,
        eventRef: firstCall.call.requestedRef
      } : null,
      ...mutations,
      firstValidation: validations.effective[0] ?? null,
      finalCompletion
    },
    completionTail: tail
  };
}
