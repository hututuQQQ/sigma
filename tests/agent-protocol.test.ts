import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  assertAgentEventEnvelope,
  assertEvidenceRecord,
  assertLegacyAgentEventEnvelopeV2,
  assertLegacySnapshotEnvelopeV2,
  assertMcpPersistentEffectsAllowed,
  assertMcpWriteRootsEmpty,
  assertSnapshotEnvelope,
  createBudgetLedger,
  createEmptyPlan,
  isAgentEventEnvelope,
  isBudgetLedgerState,
  isCheckpointRef,
  isEvidenceRecord,
  isJsonValue,
  isLegacyAgentEventEnvelopeV2,
  isLegacySnapshotEnvelopeV2,
  isPlanGraph,
  isSnapshotEnvelope,
  isSolverVisibleAuthority,
  isUsageRecord,
  McpCapabilityPolicyError,
  upcastAgentEventV2,
  type AgentEventType,
  type CheckpointRef,
  type EvidenceRecord,
  type UsageRecord
} from "../packages/agent-protocol/src/index.js";

const occurredAt = "2026-07-10T00:00:00.000Z";

function evidence(kind: "diagnostic" | "review" | "user_waiver" = "diagnostic"): EvidenceRecord {
  const base = {
    evidenceId: `evidence-${kind}`,
    sessionId: "session",
    runId: "run",
    status: "passed" as const,
    createdAt: occurredAt,
    producer: { authority: kind === "user_waiver" ? "user" as const : "runtime" as const },
    summary: "checked"
  };
  if (kind === "review") return {
    ...base, kind, data: {
      reviewerId: "reviewer", verdict: "approved", findings: [], workspaceDeltaEvidenceIds: ["delta"]
    }
  };
  if (kind === "user_waiver") return {
    ...base, kind, data: { scope: "review", reason: "explicit test waiver" }
  };
  return { ...base, kind, data: { source: "test", diagnostic: { ok: true } } };
}

function usage(): UsageRecord {
  return {
    usageId: "usage", requestId: "request", sessionId: "session", runId: "run", role: "orchestrator",
    routeId: "route", providerId: "deepseek", modelId: "model", tokenizerId: "approx", tokenizerAccuracy: "approximate",
    providerReported: false, inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, costMicroUsd: 100, latencyMs: 20, attempt: 1, occurredAt
  };
}

function checkpoint(status: CheckpointRef["status"] = "open"): CheckpointRef {
  return {
    checkpointId: "checkpoint", sessionId: "session", runId: "run", status, createdAt: occurredAt,
    preManifestDigest: "a".repeat(64),
    ...(status === "sealed" ? { sealedAt: occurredAt, postManifestDigest: "b".repeat(64) } : {}),
    ...(status === "restored" ? { restoredAt: occurredAt, postManifestDigest: "b".repeat(64) } : {})
  };
}

function payloadFor(type: AgentEventType): unknown {
  if (type === "execution.planned") return {
    executionId: "execution", toolCallId: "tool", plan: {
      exactEffects: ["filesystem.read"], readPaths: ["."], writePaths: [], network: "none",
      processMode: "none", checkpointScope: [], idempotence: "read_only"
    }
  };
  if (type === "execution.started") return { executionId: "execution" };
  if (type === "execution.completed") return { executionId: "execution", evidenceIds: [] };
  if (type === "execution.failed") return { executionId: "execution", code: "failed", message: "failed" };
  if (type === "evidence.recorded") return evidence();
  if (type === "usage.recorded") return usage();
  if (type === "review.completed") return evidence("review");
  if (type === "review.waived") return evidence("user_waiver");
  if (type === "checkpoint.created") return checkpoint("open");
  if (type === "checkpoint.sealed") return checkpoint("sealed");
  if (type === "checkpoint.restored") return checkpoint("restored");
  if (type === "checkpoint.recovery_resolved") return { checkpointId: "checkpoint", decision: "restore" };
  if (type === "plan.updated") return { previousRevision: 0, plan: { revision: 1, goal: "goal", nodes: [] } };
  if (type === "budget.reserved" || type === "budget.committed" || type === "budget.released") {
    return { reservationId: "reservation", ledger: createBudgetLedger() };
  }
  if (type === "budget.reservation_bound") {
    return { reservationId: "reservation", ownerId: "mutation", ledger: createBudgetLedger() };
  }
  if (type === "budget.limit_increased") return { ledger: createBudgetLedger(), increase: { toolCalls: 1 } };
  if (type === "budget.exhausted") return { dimension: "toolCalls", requested: 1, available: 0 };
  if (type === "budget.overrun") return {
    reservationId: "reservation",
    dimensions: [{
      dimension: "inputTokens", reserved: 120, actual: 130, overReservation: 10,
      limit: 125, consumed: 130, overLimit: 5
    }]
  };
  if (type === "process.spawned") return { processId: "process", executionId: "execution", mode: "background" };
  if (type === "process.output") return { processId: "process", stream: "stdout", chunk: "output" };
  if (type === "process.exited") return { processId: "process", exitCode: 0 };
  if (type === "process.lost") return { processId: "process", reason: "broker ended" };
  if (type === "model.route_resolved") return {
    role: "orchestrator", routeId: "route", modelSpecId: "deepseek/model", attempt: 0
  };
  if (type === "model.route_failed") return {
    role: "orchestrator", routeId: "route", modelSpecId: "deepseek/model", attempt: 0,
    category: "network", semanticDelta: false
  };
  if (type === "profile.resolved") return {
    profileId: "profile", digest: "digest", artifactId: "artifact", source: "builtin"
  };
  if (type === "customization.frozen") return {
    digest: "digest", artifactId: "artifact", skillCount: 0, hookCount: 0, profileCount: 0
  };
  if (type === "skill.loaded") return {
    qualifiedName: "home:skill", digest: "digest", artifactId: "artifact", source: "home"
  };
  if (type === "hook.started") return { hookId: "hook", event: "pre_tool", required: true };
  if (type === "hook.completed" || type === "hook.failed") return {
    hookId: "hook", event: "pre_tool", required: true, durationMs: 1, outcome: { decision: "allow" }
  };
  if (type === "review.started") return { reviewerId: "reviewer", workspaceDeltaEvidenceIds: ["delta"] };
  if (type === "run.completed") return { message: "done", evidence: [], outcomeRevision: 0 };
  return { nested: [true, 1, "text", null] };
}

function validEvent(type: AgentEventType = "diagnostic"): Record<string, unknown> {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: 1,
    eventId: "event",
    sessionId: "session",
    runId: "run",
    occurredAt,
    type,
    authority: ["review.waived", "checkpoint.recovery_resolved", "budget.limit_increased"].includes(type)
      ? "user" : "runtime",
    payload: payloadFor(type)
  };
}

describe("AgentEventEnvelope V3 runtime boundary", () => {
  it("enforces the persistent read-only MCP capability boundary with typed errors", () => {
    expect(() => assertMcpPersistentEffectsAllowed("safe", ["filesystem.read", "network"]))
      .not.toThrow();
    expect(() => assertMcpWriteRootsEmpty("safe", [])).not.toThrow();

    const required = (() => {
      try { assertMcpPersistentEffectsAllowed("implicit", undefined); } catch (error) { return error; }
    })();
    expect(required).toBeInstanceOf(McpCapabilityPolicyError);
    expect(required).toMatchObject({
      name: "McpCapabilityPolicyError", code: "mcp_effects_required",
      serverName: "implicit", forbiddenEffects: []
    });

    for (const effect of ["filesystem.write", "destructive", "open_world"] as const) {
      expect(() => assertMcpPersistentEffectsAllowed("unsafe", ["filesystem.read", effect]))
        .toThrowError(expect.objectContaining({
          code: "mcp_persistent_effect_forbidden", serverName: "unsafe", forbiddenEffects: [effect]
        }));
    }
    expect(() => assertMcpPersistentEffectsAllowed("multiple", ["filesystem.write", "open_world"]))
      .toThrowError(expect.objectContaining({ forbiddenEffects: ["filesystem.write", "open_world"] }));
    expect(() => assertMcpWriteRootsEmpty("writer", ["/workspace"]))
      .toThrowError(expect.objectContaining({
        code: "mcp_write_roots_forbidden", serverName: "writer", forbiddenEffects: ["filesystem.write"]
      }));
  });

  it("accepts every declared event type and solver-visible authority", () => {
    for (const type of AGENT_EVENT_TYPES) expect(isAgentEventEnvelope(validEvent(type)), type).toBe(true);
    for (const authority of ["system", "developer", "user", "project", "runtime", "tool"]) {
      expect(isAgentEventEnvelope({ ...validEvent(), authority })).toBe(true);
      expect(isSolverVisibleAuthority(authority as "runtime")).toBe(true);
    }
    expect(isSolverVisibleAuthority("external_verifier")).toBe(false);
    expect(() => assertAgentEventEnvelope(validEvent())).not.toThrow();
  });

  it("rejects malformed, V2, non-JSON, evaluator-controlled, and typed-payload-invalid envelopes", () => {
    const invalid: unknown[] = [
      null,
      [],
      { ...validEvent(), schemaVersion: 2 },
      { ...validEvent(), seq: 0 },
      { ...validEvent(), seq: 1.5 },
      { ...validEvent(), eventId: "" },
      { ...validEvent(), sessionId: "" },
      { ...validEvent(), runId: "" },
      { ...validEvent(), occurredAt: "not-a-date" },
      { ...validEvent(), type: "unknown" },
      { ...validEvent(), authority: "external_verifier" },
      { ...validEvent(), payload: undefined },
      { ...validEvent(), payload: Number.POSITIVE_INFINITY },
      { ...validEvent("usage.recorded"), payload: { inputTokens: -1 } },
      { ...validEvent("execution.planned"), payload: { executionId: "execution", toolCallId: "tool", plan: {} } },
      { ...validEvent("execution.failed"), payload: { executionId: "execution", code: "failed" } },
      { ...validEvent("model.route_resolved"), payload: { role: "orchestrator", attempt: -1 } },
      { ...validEvent("model.route_failed"), payload: { ...payloadFor("model.route_failed"), semanticDelta: "no" } },
      { ...validEvent("profile.resolved"), payload: { ...payloadFor("profile.resolved"), source: "remote" } },
      { ...validEvent("customization.frozen"), payload: { ...payloadFor("customization.frozen"), skillCount: -1 } },
      { ...validEvent("skill.loaded"), payload: { ...payloadFor("skill.loaded"), qualifiedName: "" } },
      { ...validEvent("hook.completed"), payload: { ...payloadFor("hook.completed"), durationMs: -1 } },
      { ...validEvent("budget.exhausted"), payload: { dimension: "tools", requested: 1, available: -1 } },
      { ...validEvent("review.started"), payload: { reviewerId: "reviewer", workspaceDeltaEvidenceIds: [1] } },
      { ...validEvent("checkpoint.created"), payload: { checkpointId: "missing-fields" } },
      { ...validEvent("checkpoint.recovery_resolved"), authority: "runtime" },
      { ...validEvent("budget.limit_increased"), authority: "runtime" },
      { ...validEvent("evidence.recorded"), payload: { ...evidence(), runId: "older-run" } },
      { ...validEvent("review.waived"), authority: "tool", payload: evidence("user_waiver") },
      { ...validEvent("plan.updated"), payload: { previousRevision: 0, plan: { revision: 1, goal: "x", nodes: [
        { id: "a", title: "a", dependencies: ["a"], status: "pending", owner: { kind: "root" }, acceptanceCriteria: [], evidence: [] }
      ] } } }
    ];
    for (const value of invalid) expect(isAgentEventEnvelope(value)).toBe(false);
    expect(() => assertAgentEventEnvelope(invalid[2])).toThrow("Invalid AgentEventEnvelope V3");
  });

  it("validates and upcasts immutable V2 event envelopes explicitly", () => {
    const legacy = { ...validEvent("diagnostic"), schemaVersion: 2 };
    expect(isLegacyAgentEventEnvelopeV2(legacy)).toBe(true);
    expect(isAgentEventEnvelope(legacy)).toBe(false);
    expect(() => assertLegacyAgentEventEnvelopeV2(legacy)).not.toThrow();
    expect(upcastAgentEventV2(legacy as never)).toEqual({ ...legacy, schemaVersion: EVENT_SCHEMA_VERSION });
    expect(isLegacyAgentEventEnvelopeV2({ ...legacy, type: "usage.recorded" })).toBe(false);
    expect(() => assertLegacyAgentEventEnvelopeV2({ ...legacy, seq: 0 })).toThrow("V2");
  });

  it("keeps snapshot V2 and V3 validation separate", () => {
    const state = { value: 1 };
    const v2 = { schemaVersion: 2, sessionId: "session", seq: 1, createdAt: occurredAt, state };
    const v3 = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId: "session", seq: 1, createdAt: occurredAt, state
    };
    expect(isLegacySnapshotEnvelopeV2(v2)).toBe(true);
    expect(isSnapshotEnvelope(v2)).toBe(false);
    expect(isSnapshotEnvelope(v3)).toBe(true);
    expect(() => assertLegacySnapshotEnvelopeV2(v2)).not.toThrow();
    expect(() => assertSnapshotEnvelope(v3)).not.toThrow();
    expect(() => assertSnapshotEnvelope({ ...v3, createdAt: "invalid" })).toThrow("V3");
    expect(() => assertLegacySnapshotEnvelopeV2({ ...v2, state: undefined })).toThrow("V2");
  });

  it("validates JSON and durable domain ledgers", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue([1, { ok: true }])).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue([() => undefined])).toBe(false);
    expect(isJsonValue({ bad: undefined })).toBe(false);
    expect(isEvidenceRecord(evidence())).toBe(true);
    expect(isEvidenceRecord({ ...evidence(), createdAt: "invalid" })).toBe(false);
    expect(isUsageRecord(usage())).toBe(true);
    expect(isUsageRecord({ ...usage(), attempt: 0 })).toBe(false);
    expect(isBudgetLedgerState(createBudgetLedger())).toBe(true);
    expect(isBudgetLedgerState({ ...createBudgetLedger(), consumed: { inputTokens: -1 } })).toBe(false);
    expect(isPlanGraph({ revision: 0, goal: "", nodes: [] })).toBe(true);
    expect(isPlanGraph({ revision: 0, goal: "", activeNodeId: "missing", nodes: [] })).toBe(false);
  });

  it("validates every durable evidence shape and rejects malformed security metadata", () => {
    const base = {
      evidenceId: "evidence", sessionId: "session", runId: "run", status: "passed",
      createdAt: occurredAt, producer: { authority: "runtime" }, summary: "checked"
    };
    const valid = [
      { ...base, kind: "workspace_delta", data: {
        checkpointId: "checkpoint", delta: { added: ["a"], modified: ["b"], deleted: ["c"] }
      } },
      { ...base, kind: "command", data: { command: "pnpm test", exitCode: null } },
      { ...base, kind: "command", data: { command: "pnpm lint", exitCode: 0 } },
      { ...base, kind: "validation", data: { validator: "tests", workspaceDeltaEvidenceIds: ["delta"] } },
      { ...base, kind: "diagnostic", data: { source: "lsp", diagnostic: null } },
      { ...base, kind: "review", data: {
        reviewerId: "reviewer", verdict: "changes_requested", findings: [],
        workspaceDeltaEvidenceIds: ["delta"], validationEvidenceIds: ["validation"]
      } },
      { ...base, kind: "checkpoint", data: {
        checkpointId: "checkpoint", checkpointStatus: "sealed", preManifestDigest: "digest"
      } },
      ...["completed", "failed", "cancelled", "blocked"].map((outcome) => ({
        ...base, kind: "child_outcome", data: { childId: "child", outcome, planNodeIds: ["node"] }
      })),
      { ...base, producer: { authority: "user" }, kind: "user_waiver", data: {
        scope: "validation", reason: "operator decision"
      } }
    ];
    for (const value of valid) {
      expect(isEvidenceRecord(value), value.kind).toBe(true);
      expect(() => assertEvidenceRecord(value)).not.toThrow();
    }

    const invalid = [
      null, [], { ...base, kind: "diagnostic", data: [] },
      { ...base, producer: null, kind: "diagnostic", data: { source: "x", diagnostic: null } },
      { ...base, kind: "workspace_delta", data: { checkpointId: "", delta: [] } },
      { ...base, kind: "command", data: { command: "", exitCode: "zero" } },
      { ...base, kind: "validation", data: { validator: "", workspaceDeltaEvidenceIds: [1] } },
      { ...base, kind: "review", data: {
        reviewerId: "reviewer", verdict: "unknown", findings: {}, workspaceDeltaEvidenceIds: []
      } },
      { ...base, kind: "review", data: {
        reviewerId: "reviewer", verdict: "approved", findings: [],
        workspaceDeltaEvidenceIds: ["delta"], validationEvidenceIds: [1]
      } },
      { ...base, kind: "checkpoint", data: {
        checkpointId: "checkpoint", checkpointStatus: "unknown", preManifestDigest: ""
      } },
      { ...base, kind: "child_outcome", data: { childId: "", outcome: "unknown", planNodeIds: [1] } },
      { ...base, kind: "user_waiver", data: { scope: "other", reason: "" } }
    ];
    for (const value of invalid) expect(isEvidenceRecord(value)).toBe(false);
    expect(() => assertEvidenceRecord(invalid.at(-1))).toThrow("Invalid EvidenceRecord");
  });

  it("checks plan graph topology, budget reservations, usage assets, and checkpoint postimages", () => {
    const evidenceRef = { evidenceId: "evidence", kind: "validation" };
    const node = (id: string, dependencies: string[] = []) => ({
      id, title: id, dependencies, status: "pending", owner: { kind: "root" },
      acceptanceCriteria: [], evidence: []
    });
    const completed = {
      ...node("done"), status: "completed", owner: { kind: "child", childId: "child" },
      evidence: [evidenceRef]
    };
    const blocked = { ...node("blocked", ["done"]), status: "blocked", blockedReason: "dependency unavailable" };
    expect(isPlanGraph({ revision: 3, goal: "goal", activeNodeId: "blocked", nodes: [completed, blocked] })).toBe(true);
    expect(isPlanGraph(createEmptyPlan())).toBe(true);
    expect(createEmptyPlan("goal").goal).toBe("goal");
    for (const graph of [
      null,
      { revision: 0, goal: "", nodes: [null] },
      { revision: 0, goal: "", nodes: [{ ...node("a"), owner: [] }] },
      { revision: 0, goal: "", nodes: [{ ...node("a"), owner: { kind: "child", childId: "" } }] },
      { revision: 0, goal: "", nodes: [{ ...node("a"), status: "blocked" }] },
      { revision: 0, goal: "", nodes: [{ ...node("a"), status: "completed" }] },
      { revision: 0, goal: "", nodes: [node("same"), node("same")] },
      { revision: 0, goal: "", nodes: [node("a", ["missing"])] },
      { revision: 0, goal: "", nodes: [node("a", ["b"]), node("b", ["a"])] }
    ]) expect(isPlanGraph(graph)).toBe(false);

    const ledger = createBudgetLedger();
    const amount = { inputTokens: 1, outputTokens: 2, costMicroUsd: 3, modelTurns: 1, toolCalls: 1, children: 0 };
    const reservation = {
      reservationId: "reservation", ownerId: "owner", status: "committed",
      requested: amount, consumed: amount, createdAt: occurredAt, settledAt: occurredAt
    };
    expect(isBudgetLedgerState({ ...ledger, reservations: [reservation] })).toBe(true);
    expect(isBudgetLedgerState({ ...ledger, reservations: [{ ...reservation, settledAt: "invalid" }] })).toBe(false);
    expect(isBudgetLedgerState({ ...ledger, limits: { ...ledger.limits, maxDepth: -1 } })).toBe(false);

    expect(isUsageRecord({ ...usage(), tokenizerAccuracy: "exact", tokenizerAssetDigest: "a".repeat(64) })).toBe(true);
    expect(isUsageRecord(null)).toBe(false);
    expect(isUsageRecord({ ...usage(), tokenizerAssetDigest: "not-a-digest" })).toBe(false);
    expect(isUsageRecord({ ...usage(), extra: () => undefined })).toBe(false);

    const restored = {
      ...checkpoint("restored"), sealedAt: occurredAt,
      delta: { added: [], modified: ["file.ts"], deleted: [] }
    };
    expect(isCheckpointRef(restored)).toBe(true);
    expect(isCheckpointRef({ ...restored, restoredAt: "invalid" })).toBe(false);
    expect(isCheckpointRef({ ...restored, delta: { added: [], modified: [], deleted: [1] } })).toBe(false);
  });
});
