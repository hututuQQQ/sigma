import {
  EVENT_SCHEMA_VERSION,
  createBudgetLedger,
  emptyLongHorizonState,
  emptyReasoningTrajectoryState,
  type AgentEventPayloadMap,
  type AgentEventType,
  type CheckpointRef,
  type EvidenceRecord,
  type ModelGateway,
  type RunMode,
  type UsageRecord
} from "../../packages/agent-protocol/src/index.js";
import { freezeSessionCustomization } from "../../packages/agent-extensions/src/index.js";
import { ContentAddressedArtifactStore } from "../../packages/agent-store/src/index.js";
import { compileHarnessBuild } from "../../packages/agent-runtime/src/harness-compiler.js";

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
      schemaVersion: 1, reviewerId: "reviewer", verdict: "approved", findings: [],
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

export async function persistEmptyCustomization(
  storeRootDir: string,
  sessionId: string
): Promise<{
  digest: string;
  artifactId: string;
  skillCount: 0;
  hookCount: 0;
  profileCount: 0;
}> {
  const customization = await freezeSessionCustomization({});
  const artifactId = await new ContentAddressedArtifactStore(storeRootDir)
    .put(sessionId, customization.canonicalJson);
  return {
    digest: customization.digest,
    artifactId,
    skillCount: 0,
    hookCount: 0,
    profileCount: 0
  };
}

export async function persistCompiledHarnessFixture(
  storeRootDir: string,
  sessionId: string,
  gateway: ModelGateway,
  toolNames: readonly string[],
  mode: RunMode = "change"
): Promise<AgentEventPayloadMap["harness.compiled"]> {
  const build = compileHarnessBuild({
    provider: gateway.provider,
    model: gateway.model,
    modelRole: "orchestrator",
    runMode: mode,
    modelCapabilities: gateway.capabilities,
    runtimeCapabilities: {
      tools: toolNames.map((name) => ({ name, source: "mcp" as const })),
      executionMode: "sandboxed",
      writeScope: "workspace",
      managedEnvironment: false,
      network: "full",
      interactiveApprovals: false
    }
  });
  const artifactId = await new ContentAddressedArtifactStore(storeRootDir)
    .put(sessionId, build.canonicalJson);
  return {
    schemaVersion: build.schemaVersion,
    compilerVersion: build.compilerVersion,
    digest: build.digest,
    artifactId,
    policyPackIds: [...build.policyPackIds],
    initialToolCount: build.toolPolicy.initialTools.length,
    potentialToolCount: build.toolPolicy.potentialTools.length
  };
}

const ledger = createBudgetLedger();
const zeroBudget = { ...ledger.consumed };
const reservation = {
  reservationId: "reservation",
  ownerId: "unbound",
  status: "reserved" as const,
  requested: zeroBudget,
  consumed: zeroBudget,
  createdAt: fixtureOccurredAt
};
const message = { role: "assistant", content: "done" } as const;
const receipt = {
  callId: "call", name: "read", ok: true, output: "ok",
  outcome: { status: "succeeded", output: "ok", diagnosticCodes: [] },
  observedEffects: ["filesystem.read"], actualEffects: ["filesystem.read"],
  artifacts: [], diagnostics: [], evidence: [],
  startedAt: fixtureOccurredAt, completedAt: fixtureOccurredAt, ...turn
} as const;
const hookOutcome = {
  hookId: "hook", event: "pre_tool", required: true, status: "allowed", durationMs: 1
} as const;

export const agentEventPayloadFixtures = {
  "session.created": {
    workspacePath: "D:/workspace", mode: "change", title: "task", writeScope: ["."],
    strictWriteScope: true, modelRole: "orchestrator", budgetLimits: ledger.limits
  },
  "run.started": { mode: "change", deadlineAt: fixtureOccurredAt },
  "run.suspended": { kind: "needs_input", requestId: "input", message: "choose" },
  "run.completed": { kind: "completed", message: "done", evidence: [], outcomeRevision: 1 },
  "run.cancelled": { kind: "cancelled", reason: "cancelled", outcomeRevision: 1 },
  "run.failed": { kind: "fatal", code: "failed", message: "failed", outcomeRevision: 1 },
  "user.message": { text: "hello" },
  "user.steer": { text: "adjust" },
  "user.follow_up": { text: "continue", queueId: "queue", status: "queued" },
  "session.history_rolled_back": { numTurns: 1 },
  "model.started": { provider: "provider", model: "model", ...turn },
  "model.prompt_materialized": {
    ...turn,
    messages: [{
      role: "developer",
      content: "[runtime prompt frame; applies only to the immediately following assistant turn]"
    }],
    toolSchemaDigest: "a".repeat(64),
    requestDigest: "b".repeat(64),
    prefixMessageCount: 1,
    cacheMode: "prefix_cache",
    promptState: {
      schemaVersion: 1,
      sectionDigests: {},
      budgetBand: 100
    },
    frameMode: "full"
  },
  "model.delta": { turnId: 1, delta: "text" },
  "model.reasoning_delta": { turnId: 1, delta: "reasoning" },
  "model.completed": {
    model: "model", ...turn, text: "done", finishReason: "stop", message, toolCalls: [], usage: usageFixture()
  },
  "model.failed": { ...turn, code: "model_error", message: "failed" },
  "tool.requested": { callId: "call", name: "read", arguments: {}, ...turn },
  "tool.approval_requested": {
    requestId: "call", callId: "call", toolName: "read", arguments: {}, effects: ["filesystem.read"],
    plan, reason: "approval", approvalMode: "human", ...turn
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
  "context.tool_results_pruned": {
    state: {
      schemaVersion: 1,
      coveredBlocks: 1,
      sourceDigest: "a".repeat(64)
    },
    protectedTokens: 40_000,
    prunedTokens: 20_000
  },
  "context.reasoning_trajectory_tombstoned": {
    state: emptyReasoningTrajectoryState(),
    newlyTombstoned: 0
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
    processId: "process", executionId: "execution", mode: "background", lifecycle: "session", brokerInstanceId: "broker"
  },
  "process.output": { processId: "process", stream: "stdout", chunk: "output" },
  "process.exited": { processId: "process", exitCode: 0, state: "exited" },
  "process.lost": { processId: "process", reason: "broker ended" },
  "process.handed_off": { processId: "process", handoffId: "handoff", systemProcessId: 1234 },
  "evidence.recorded": evidenceFixture(),
  "usage.recorded": usageFixture(),
  "model.route_resolved": { role: "orchestrator", routeId: "route", modelSpecId: "provider/model", attempt: 1 },
  "model.route_failed": {
    role: "orchestrator", routeId: "route", modelSpecId: "provider/model", attempt: 1,
    category: "network", semanticDelta: false
  },
  "profile.resolved": { profileId: "profile", digest: "digest", artifactId: "artifact", source: "builtin" },
  "customization.frozen": { digest: "digest", artifactId: "artifact", skillCount: 0, hookCount: 0 },
  "harness.compiled": {
    schemaVersion: 1,
    compilerVersion: "1.0.0",
    digest: "a".repeat(64),
    artifactId: "a".repeat(64),
    policyPackIds: ["sigma.flagship.v1"],
    initialToolCount: 9,
    potentialToolCount: 30
  },
  "tool_bundle.loaded": {
    bundleId: "filesystem",
    harnessDigest: "a".repeat(64),
    toolCount: 6
  },
  "skill.loaded": { qualifiedName: "home:skill", digest: "digest", artifactId: "artifact", source: "home" },
  "hook.started": { hookId: "hook", event: "pre_tool", required: true, kind: "command" },
  "hook.completed": { hookId: "hook", event: "pre_tool", required: true, durationMs: 1, outcome: hookOutcome },
  "hook.failed": {
    hookId: "hook", event: "pre_tool", required: true, durationMs: 1,
    outcome: { ...hookOutcome, status: "failed", reason: "failed" }
  },
  "plan.updated": { previousRevision: 0, plan: { revision: 1, goal: "goal", nodes: [] } },
  "long_horizon.updated": {
    state: emptyLongHorizonState(),
    reason: "batch_settled"
  },
  "budget.reserved": {
    reservationId: "reservation",
    mutation: {
      schemaVersion: 1, kind: "reserve", reservation,
      totals: { consumed: zeroBudget, reserved: zeroBudget }
    }
  },
  "budget.reservation_bound": {
    reservationId: "reservation",
    ownerId: "owner",
    mutation: { schemaVersion: 1, kind: "bind", reservationId: "reservation", ownerId: "owner" }
  },
  "budget.committed": {
    reservationId: "reservation",
    mutation: {
      schemaVersion: 1, kind: "settle", reservationId: "reservation", status: "committed",
      consumed: zeroBudget, settledAt: fixtureOccurredAt,
      totals: { consumed: zeroBudget, reserved: zeroBudget }
    }
  },
  "budget.released": {
    reservationId: "reservation",
    mutation: {
      schemaVersion: 1, kind: "settle", reservationId: "reservation", status: "released",
      consumed: zeroBudget, settledAt: fixtureOccurredAt,
      totals: { consumed: zeroBudget, reserved: zeroBudget }
    }
  },
  "budget.exhausted": { dimension: "toolCalls", requested: 1, available: 0 },
  "budget.overrun": {
    reservationId: "reservation", dimensions: [{
      dimension: "inputTokens", reserved: 1, actual: 2, overReservation: 1,
      limit: 1, consumed: 2, overLimit: 1
    }]
  },
  "budget.limit_increased": {
    mutation: {
      schemaVersion: 1,
      kind: "limit",
      increase: { ...zeroBudget, toolCalls: 1, maxDepth: 0 },
      limits: ledger.limits
    }
  },
  "checkpoint.created": checkpointFixture("open"),
  "checkpoint.sealed": checkpointFixture("sealed"),
  "checkpoint.restored": checkpointFixture("restored"),
  "checkpoint.recovery_resolved": { checkpointId: "checkpoint", decision: "restore" },
  "review.started": { reviewerId: "reviewer", workspaceDeltaEvidenceIds: ["delta"] },
  "review.tool_completed": {
    schemaVersion: 1,
    reviewRequestId: "review-request",
    call: { id: "review-call", name: "read", arguments: { path: "README.md" } },
    plan,
    receipt: {
      callId: "review-call",
      ok: true,
      output: "reviewed",
      outcome: { status: "succeeded", output: "reviewed", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      actualEffects: ["filesystem.read"],
      artifacts: [],
      diagnostics: [],
      evidence: [],
      startedAt: fixtureOccurredAt,
      completedAt: fixtureOccurredAt
    }
  },
  "review.completed": evidenceFixture("review"),
  "review.waived": evidenceFixture("user_waiver")
} as const satisfies AgentEventPayloadMap;

export function authorityForEvent(type: AgentEventType): "runtime" | "user" {
  return [
    "review.waived",
    "checkpoint.recovery_resolved",
    "budget.limit_increased",
    "session.history_rolled_back"
  ].includes(type)
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
  if (type === "model.completed" && completed.message
    && typeof completed.message === "object" && !Array.isArray(completed.message)) {
    const durableMessage = completed.message as Record<string, unknown>;
    completed.text = typeof durableMessage.content === "string" ? durableMessage.content : "";
    completed.toolCalls = Array.isArray(durableMessage.toolCalls) ? durableMessage.toolCalls : [];
  }
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
