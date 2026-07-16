import {
  EVENT_SCHEMA_VERSION,
  createBudgetLedger,
  type AgentEventPayloadMap,
  type AgentEventType,
  type CheckpointRef,
  type EvidenceRecord,
  type UsageRecord
} from "../../packages/agent-protocol/src/index.js";

export const fixtureOccurredAt = "2026-07-10T00:00:00.000Z";
const turn = { turnId: 1, effectRevision: 0 } as const;
const plan = {
  exactEffects: ["filesystem.read"], readPaths: ["."], writePaths: [], network: "none",
  processMode: "none", checkpointScope: [], idempotence: "read_only"
} as const;

export function evidenceFixture(
  kind: "diagnostic" | "review" | "user_waiver" = "diagnostic"
): EvidenceRecord {
  const base = {
    evidenceId: `evidence-${kind}`, sessionId: "session", runId: "run", status: "passed" as const,
    createdAt: fixtureOccurredAt, summary: "checked"
  };
  if (kind === "review") return {
    ...base, kind, producer: { authority: "runtime" }, data: {
      reviewerId: "reviewer", verdict: "approved", findings: [],
      frontierRevision: 1, stateDigest: "a".repeat(64)
    }
  };
  if (kind === "user_waiver") return {
    ...base, kind, producer: { authority: "user" }, data: { scope: "review", reason: "explicit waiver" }
  };
  return {
    ...base, kind, producer: { authority: "runtime" }, data: { source: "test", diagnostic: { ok: true } }
  };
}

export function usageFixture(): UsageRecord {
  return {
    usageId: "usage", requestId: "request", sessionId: "session", runId: "run", role: "orchestrator",
    routeId: "route", providerId: "provider", modelId: "model", tokenizerId: "approx",
    tokenizerAccuracy: "approximate", providerReported: false, inputTokens: 10, outputTokens: 2,
    reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 100,
    latencyMs: 20, attempt: 1, occurredAt: fixtureOccurredAt
  };
}

export function checkpointFixture(status: CheckpointRef["status"]): CheckpointRef {
  return {
    checkpointId: "checkpoint", sessionId: "session", runId: "run", status, createdAt: fixtureOccurredAt,
    preManifestDigest: "a".repeat(64),
    ...(status === "sealed" ? { sealedAt: fixtureOccurredAt, postManifestDigest: "b".repeat(64) } : {}),
    ...(status === "restored" ? { restoredAt: fixtureOccurredAt, postManifestDigest: "b".repeat(64) } : {})
  };
}

const ledger = createBudgetLedger();
const message = { role: "assistant", content: "done" } as const;
const receipt = {
  callId: "call", name: "read", ok: true, output: "ok",
  outcome: { status: "succeeded", output: "ok", diagnosticCodes: [] },
  observedEffects: ["filesystem.read"], artifacts: [], diagnostics: [],
  startedAt: fixtureOccurredAt, completedAt: fixtureOccurredAt, ...turn
} as const;
const hookOutcome = {
  hookId: "hook", event: "pre_tool", required: true, status: "allowed", durationMs: 1
} as const;

export const agentEventPayloadFixtures = {
  "session.created": {
    workspacePath: "D:/workspace", mode: "change", title: "task", writeScope: ["."],
    strictWriteScope: true, modelRole: "orchestrator"
  },
  "run.started": { mode: "change", deadlineAt: fixtureOccurredAt },
  "run.suspended": { kind: "needs_input", requestId: "input", message: "choose" },
  "run.completed": { kind: "completed", message: "done", evidence: [], outcomeRevision: 1 },
  "run.cancelled": { kind: "cancelled", reason: "cancelled", outcomeRevision: 1 },
  "run.failed": { kind: "fatal", code: "failed", message: "failed", outcomeRevision: 1 },
  "user.message": { text: "hello" },
  "user.steer": { text: "adjust" },
  "user.follow_up": { text: "continue", queueId: "queue", status: "queued" },
  "model.started": { provider: "provider", model: "model", ...turn },
  "model.delta": { turnId: 1, delta: "text" },
  "model.reasoning_delta": { turnId: 1, delta: "reasoning" },
  "model.completed": {
    model: "model", ...turn, text: "done", finishReason: "stop", message, toolCalls: [], usage: usageFixture()
  },
  "model.failed": { ...turn, code: "model_error", message: "failed" },
  "tool.requested": { callId: "call", name: "read", arguments: {}, ...turn },
  "tool.approval_requested": {
    requestId: "call", callId: "call", toolName: "read", arguments: {}, effects: ["filesystem.read"],
    plan, reason: "approval", ...turn
  },
  "tool.approval_resolved": { requestId: "call", callId: "call", decision: "allow", ...turn },
  "tool.started": { callId: "call", name: "read", ...turn },
  "tool.progress": { callId: "call", name: "read", message: "working", percent: 50, ...turn },
  "tool.completed": receipt,
  "tool.failed": { ...receipt, ok: false, outcome: { status: "failed", output: "failed", diagnosticCodes: ["failed"] } },
  "context.compacted": {
    item: {
      id: "summary", authority: "runtime", provenance: "compaction", content: "summary",
      tokenCount: 2, priority: 1
    }, omittedHistoryTurns: 1
  },
  "child.spawned": { childId: "child", payload: { status: "queued" } },
  "child.message": { childId: "child", payload: { kind: "started" } },
  "child.completed": { childId: "child", payload: { status: "completed" } },
  diagnostic: { kind: "recovery.retry_model", message: "retrying" },
  "execution.planned": { executionId: "execution", toolCallId: "call", plan },
  "execution.started": { executionId: "execution" },
  "execution.completed": { executionId: "execution", evidenceIds: [] },
  "execution.failed": { executionId: "execution", code: "failed", message: "failed" },
  "process.spawned": {
    processId: "process", executionId: "execution", mode: "background", brokerInstanceId: "broker"
  },
  "process.output": { processId: "process", stream: "stdout", chunk: "output" },
  "process.exited": { processId: "process", exitCode: 0, state: "exited" },
  "process.lost": { processId: "process", reason: "broker ended" },
  "evidence.recorded": evidenceFixture(),
  "usage.recorded": usageFixture(),
  "model.route_resolved": { role: "orchestrator", routeId: "route", modelSpecId: "provider/model", attempt: 1 },
  "model.route_failed": {
    role: "orchestrator", routeId: "route", modelSpecId: "provider/model", attempt: 1,
    category: "network", semanticDelta: false
  },
  "profile.resolved": { profileId: "profile", digest: "digest", artifactId: "artifact", source: "builtin" },
  "customization.frozen": { digest: "digest", artifactId: "artifact", skillCount: 0, hookCount: 0 },
  "skill.loaded": { qualifiedName: "home:skill", digest: "digest", artifactId: "artifact", source: "home" },
  "hook.started": { hookId: "hook", event: "pre_tool", required: true, kind: "command" },
  "hook.completed": { hookId: "hook", event: "pre_tool", required: true, durationMs: 1, outcome: hookOutcome },
  "hook.failed": {
    hookId: "hook", event: "pre_tool", required: true, durationMs: 1,
    outcome: { ...hookOutcome, status: "failed", reason: "failed" }
  },
  "plan.updated": { previousRevision: 0, plan: { revision: 1, goal: "goal", nodes: [] } },
  "budget.reserved": { reservationId: "reservation", ledger },
  "budget.reservation_bound": { reservationId: "reservation", ownerId: "owner", ledger },
  "budget.committed": { reservationId: "reservation", ledger },
  "budget.released": { reservationId: "reservation", ledger },
  "budget.exhausted": { dimension: "toolCalls", requested: 1, available: 0 },
  "budget.overrun": {
    reservationId: "reservation", dimensions: [{
      dimension: "inputTokens", reserved: 1, actual: 2, overReservation: 1,
      limit: 1, consumed: 2, overLimit: 1
    }]
  },
  "budget.limit_increased": { previousLimits: ledger.limits, increase: { toolCalls: 1 }, ledger },
  "checkpoint.created": checkpointFixture("open"),
  "checkpoint.sealed": checkpointFixture("sealed"),
  "checkpoint.restored": checkpointFixture("restored"),
  "checkpoint.recovery_resolved": { checkpointId: "checkpoint", decision: "restore" },
  "review.started": { reviewerId: "reviewer", workspaceDeltaEvidenceIds: ["delta"] },
  "review.completed": evidenceFixture("review"),
  "review.waived": evidenceFixture("user_waiver")
} as const satisfies AgentEventPayloadMap;

export function authorityForEvent(type: AgentEventType): "runtime" | "user" {
  return ["review.waived", "checkpoint.recovery_resolved", "budget.limit_increased"].includes(type)
    ? "user" : "runtime";
}

export function validAgentEventFixture(type: AgentEventType = "diagnostic"): Record<string, unknown> {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION, seq: 1, eventId: "event", sessionId: "session", runId: "run",
    occurredAt: fixtureOccurredAt, type, authority: authorityForEvent(type), payload: agentEventPayloadFixtures[type]
  };
}

/** Completes a hand-written producer payload without weakening production validation. */
export function completeAgentEventPayload(type: AgentEventType, payload: unknown): unknown {
  const supplied = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  if (type === "diagnostic") {
    if (supplied.kind === "nested_instructions_loaded") return {
      kind: supplied.kind,
      callId: supplied.callId ?? "fixture-call",
      provenance: supplied.provenance ?? [],
      items: supplied.items ?? [],
      affectsMutation: supplied.affectsMutation ?? false
    };
    if (typeof supplied.kind === "string") {
      return supplied.kind === "recovery.retry_model" && typeof supplied.message !== "string"
        ? { ...supplied, message: "fixture recovery" } : supplied;
    }
    return { kind: "recovery.retry_model", message: JSON.stringify(supplied) || "fixture diagnostic" };
  }
  const baseline = structuredClone(agentEventPayloadFixtures[type]) as Record<string, unknown>;
  if (type === "session.created") Object.assign(baseline, {
    title: "", writeScope: [], strictWriteScope: false, modelRole: "orchestrator"
  });
  if (type === "run.started") baseline.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const completed = { ...baseline, ...supplied };
  if (type === "review.completed" && completed.data && typeof completed.data === "object") {
    completed.data = {
      ...(completed.data as Record<string, unknown>),
      frontierRevision: (completed.data as Record<string, unknown>).frontierRevision ?? 1,
      stateDigest: (completed.data as Record<string, unknown>).stateDigest ?? "a".repeat(64)
    };
    delete (completed.data as Record<string, unknown>).workspaceDeltaEvidenceIds;
  }
  if (type === "tool.completed" || type === "tool.failed") {
    for (const field of ["startedAt", "completedAt"] as const) {
      if (typeof completed[field] !== "string" || !Number.isFinite(Date.parse(completed[field]))) {
        completed[field] = fixtureOccurredAt;
      }
    }
  }
  return completed;
}
