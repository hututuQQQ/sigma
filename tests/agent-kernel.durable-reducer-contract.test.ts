import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import { createKernelState, type KernelState } from "../packages/agent-kernel/src/index.js";
import {
  durableReducers,
  type KernelEventReducer
} from "../packages/agent-kernel/src/durable-reducers.js";

const NOW = "2026-01-01T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function initial(): KernelState {
  return createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-01-01T00:01:00.000Z"
  });
}

function event(
  type: AgentEventType,
  payload: JsonValue,
  overrides: Partial<AgentEventEnvelope> = {}
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: 1,
    eventId: `event-${type}`,
    sessionId: "session",
    runId: "run",
    occurredAt: NOW,
    type,
    authority: "runtime",
    payload,
    ...overrides
  } as AgentEventEnvelope;
}

function reduce(
  state: KernelState,
  type: keyof typeof durableReducers,
  payload: JsonValue,
  overrides: Partial<AgentEventEnvelope> = {},
  reducer: KernelEventReducer | undefined = durableReducers[type]
): KernelState {
  if (!reducer) throw new Error(`Missing durable reducer for ${type}.`);
  return reducer(state, event(type, payload, overrides), payload as Record<string, JsonValue>);
}

function diagnosticEvidence(
  evidenceId: string,
  producer: "runtime" | "tool" = "runtime"
): EvidenceRecord {
  return {
    evidenceId,
    sessionId: "session",
    runId: "run",
    kind: "diagnostic",
    status: "passed",
    createdAt: NOW,
    producer: { authority: producer },
    summary: "diagnostic",
    data: { source: "contract", diagnostic: { ok: true } }
  };
}

function workspaceDelta(evidenceId: string, checkpointId = "checkpoint"): EvidenceRecord {
  return {
    evidenceId,
    sessionId: "session",
    runId: "run",
    kind: "workspace_delta",
    status: "passed",
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: "workspace changed",
    data: {
      checkpointId,
      delta: { added: [], modified: ["src/index.ts"], deleted: [] }
    }
  };
}

function reviewEvidence(evidenceId: string): EvidenceRecord {
  return {
    evidenceId,
    sessionId: "session",
    runId: "run",
    kind: "review",
    status: "passed",
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: "approved",
    data: {
      reviewerId: "reviewer",
      verdict: "approved",
      findings: [],
      workspaceDeltaEvidenceIds: []
    }
  };
}

function waiverEvidence(evidenceId: string): EvidenceRecord {
  return {
    evidenceId,
    sessionId: "session",
    runId: "run",
    kind: "user_waiver",
    status: "informational",
    createdAt: NOW,
    producer: { authority: "user" },
    summary: "waived",
    data: { scope: "review", reason: "operator approved" }
  };
}

describe("durable reducer contracts", () => {
  it("requires the exact evidence authority, kind, producer, and identity tuple", () => {
    const state = initial();
    const review = reviewEvidence("review");
    expect(reduce(state, "review.completed", review).evidence).toEqual([review]);
    expect(reduce(state, "review.completed", review, { authority: "tool" })).toBe(state);
    expect(reduce(state, "review.completed", diagnosticEvidence("wrong-kind"))).toBe(state);
    expect(reduce(state, "review.completed", {
      ...review,
      producer: { authority: "tool" }
    } as EvidenceRecord)).toBe(state);

    const waiver = waiverEvidence("waiver");
    expect(reduce(state, "review.waived", waiver, { authority: "user" }).evidence).toEqual([waiver]);
    expect(reduce(state, "review.waived", waiver).evidence).toEqual([]);
    expect(reduce(state, "review.waived", review, { authority: "user" })).toBe(state);
    expect(reduce(state, "review.waived", {
      ...waiver,
      producer: { authority: "runtime" }
    } as EvidenceRecord, { authority: "user" })).toBe(state);

    const toolEvidence = diagnosticEvidence("tool", "tool");
    expect(reduce(state, "evidence.recorded", toolEvidence, { authority: "tool" }).evidence)
      .toEqual([toolEvidence]);
    expect(reduce(state, "evidence.recorded", diagnosticEvidence("runtime"), { authority: "tool" }))
      .toBe(state);
    expect(reduce(state, "evidence.recorded", toolEvidence)).toBe(state);
    expect(reduce(state, "evidence.recorded", {
      ...review,
      producer: { authority: "tool" }
    } as EvidenceRecord, { authority: "tool" })).toBe(state);
    expect(reduce(state, "evidence.recorded", review)).toBe(state);

    const evidenceReducer = durableReducers["evidence.recorded"];
    expect(reduce(
      state,
      "evidence.recorded",
      diagnosticEvidence("wrong-event"),
      { type: "diagnostic" },
      evidenceReducer
    )).toBe(state);
    expect(reduce(state, "evidence.recorded", {
      ...diagnosticEvidence("foreign-session"),
      sessionId: "other"
    })).toBe(state);
    expect(reduce(state, "evidence.recorded", {
      ...diagnosticEvidence("foreign-run"),
      runId: "other"
    })).toBe(state);
    expect(reduce(state, "evidence.recorded", diagnosticEvidence("event-run"), { runId: "other" }))
      .toBe(state);
  });

  it("deduplicates evidence, mutation evidence, usage, and user waivers independently", () => {
    const delta = workspaceDelta("delta");
    const seeded = { ...initial(), mutationEvidence: [delta] };
    const recorded = reduce(seeded, "evidence.recorded", delta);
    expect(recorded.evidence).toEqual([delta]);
    expect(recorded.mutationEvidence).toEqual([delta]);

    const duplicate = { ...recorded, evidence: [delta] };
    expect(reduce(duplicate, "evidence.recorded", delta)).toBe(duplicate);

    const firstWaiver = waiverEvidence("waiver-one");
    const waived = reduce(initial(), "review.waived", firstWaiver, { authority: "user" });
    expect(reduce(waived, "review.waived", waiverEvidence("waiver-two"), { authority: "user" }))
      .toBe(waived);

    const usage = {
      usageId: "usage",
      requestId: "request",
      sessionId: "session",
      runId: "run",
      role: "orchestrator",
      routeId: "route",
      providerId: "provider",
      modelId: "model",
      tokenizerId: "tokenizer",
      tokenizerAccuracy: "exact",
      providerReported: true,
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 3,
      latencyMs: 4,
      attempt: 1,
      occurredAt: NOW
    } as const;
    const used = reduce(initial(), "usage.recorded", usage);
    expect(used.usage).toEqual([usage]);
    expect(reduce(used, "usage.recorded", usage)).toBe(used);
    const unused = initial();
    expect(reduce(unused, "usage.recorded", { ...usage, sessionId: "other" })).toBe(unused);
  });

  it("requires monotonic plans and validates frozen runtime identities", () => {
    const state = initial();
    const nextPlan = {
      revision: 1,
      goal: "ship",
      activeNodeId: "step",
      nodes: [{
        id: "step",
        title: "Implement",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["implemented"],
        evidence: []
      }]
    };
    expect(reduce(state, "plan.updated", { previousRevision: 0, plan: nextPlan }).plan)
      .toEqual(nextPlan);
    expect(reduce(state, "plan.updated", { previousRevision: "0", plan: nextPlan })).toBe(state);
    expect(reduce(state, "plan.updated", { previousRevision: 1, plan: nextPlan })).toBe(state);
    expect(reduce(state, "plan.updated", {
      previousRevision: 0,
      plan: { ...nextPlan, revision: 2 }
    })).toBe(state);

    const profile = {
      profileId: "workspace:secure",
      digest: DIGEST_A,
      artifactId: DIGEST_B,
      source: "workspace"
    };
    expect(reduce(state, "profile.resolved", profile).frozenProfile)
      .toMatchObject({ qualifiedName: profile.profileId, source: "workspace" });
    for (const invalid of [
      { ...profile, profileId: 1 },
      { ...profile, digest: 1 },
      { ...profile, artifactId: 1 },
      { ...profile, digest: "short" },
      { ...profile, artifactId: "A".repeat(64) },
      { ...profile, source: "remote" }
    ]) expect(reduce(state, "profile.resolved", invalid)).toBe(state);
    expect(reduce(state, "profile.resolved", profile, { authority: "tool" })).toBe(state);
    expect(reduce(state, "profile.resolved", profile, { sessionId: "other" })).toBe(state);

    const customization = { digest: DIGEST_A, artifactId: DIGEST_B };
    expect(reduce(state, "customization.frozen", customization).frozenCustomization)
      .toEqual(customization);
    expect(reduce(state, "customization.frozen", customization, { authority: "user" })).toBe(state);
    expect(reduce(state, "customization.frozen", customization, { sessionId: "other" })).toBe(state);
    for (const invalid of [
      { ...customization, digest: `x${DIGEST_A}` },
      { ...customization, digest: `${DIGEST_A}x` },
      { ...customization, artifactId: `x${DIGEST_B}` },
      { ...customization, artifactId: `${DIGEST_B}x` }
    ]) expect(reduce(state, "customization.frozen", invalid)).toBe(state);

    const skill = {
      qualifiedName: "workspace:typescript",
      digest: DIGEST_A,
      artifactId: DIGEST_B,
      source: "workspace"
    };
    const loaded = reduce(state, "skill.loaded", skill);
    expect(loaded.frozenSkills).toHaveLength(1);
    expect(reduce(loaded, "skill.loaded", skill)).toBe(loaded);
    expect(reduce(state, "skill.loaded", skill, { authority: "tool" })).toBe(state);
    expect(reduce(state, "skill.loaded", skill, { sessionId: "other" })).toBe(state);
    for (const invalid of [
      { ...skill, qualifiedName: 1 },
      { ...skill, digest: 1 },
      { ...skill, artifactId: 1 },
      { ...skill, digest: "short" },
      { ...skill, artifactId: "A".repeat(64) },
      { ...skill, source: "remote" }
    ]) expect(reduce(state, "skill.loaded", invalid)).toBe(state);

    const completeManifest = {
      ...skill,
      qualifiedName: "workspace:manifest",
      executionManifestArtifactId: DIGEST_A,
      executionManifestDigest: DIGEST_B
    };
    expect(reduce(state, "skill.loaded", completeManifest).frozenSkills[0])
      .toMatchObject(completeManifest);
    for (const invalidManifest of [
      { ...completeManifest, qualifiedName: "bad-prefix", executionManifestArtifactId: `x${DIGEST_A}` },
      { ...completeManifest, qualifiedName: "bad-suffix", executionManifestDigest: `${DIGEST_B}x` }
    ]) expect(reduce(state, "skill.loaded", invalidManifest).frozenSkills[0])
      .not.toHaveProperty("executionManifestArtifactId");
  });

  it("enforces checkpoint status, authority, event identity, and cross-run restore rules", () => {
    const state = initial();
    const checkpoint = {
      checkpointId: "checkpoint",
      sessionId: "session",
      runId: "run",
      status: "open",
      createdAt: NOW,
      preManifestDigest: DIGEST_A
    } as const;
    expect(reduce(state, "checkpoint.created", checkpoint).checkpointHead).toEqual(checkpoint);
    expect(reduce(state, "checkpoint.created", { ...checkpoint, status: "sealed" })).toBe(state);
    expect(reduce(state, "checkpoint.created", checkpoint, { authority: "tool" })).toBe(state);
    expect(reduce(state, "checkpoint.created", { ...checkpoint, sessionId: "other" })).toBe(state);
    expect(reduce(state, "checkpoint.created", checkpoint, { sessionId: "other" })).toBe(state);
    expect(reduce(state, "checkpoint.created", checkpoint, { runId: "other" })).toBe(state);

    const sealed = {
      ...checkpoint,
      status: "sealed",
      sealedAt: NOW,
      postManifestDigest: DIGEST_B
    } as const;
    expect(reduce(state, "checkpoint.sealed", sealed).checkpointHead).toEqual(sealed);
    expect(reduce(state, "checkpoint.sealed", { ...sealed, runId: "other" })).toBe(state);

    const restored = {
      ...sealed,
      runId: "old-run",
      status: "restored",
      restoredAt: NOW
    } as const;
    expect(reduce(state, "checkpoint.restored", restored).checkpointHead)
      .toMatchObject({ checkpointId: "checkpoint", runId: "run", status: "restored" });
    expect(reduce(state, "checkpoint.restored", restored, { authority: "user" }).checkpointHead)
      .toMatchObject({ runId: "run" });
    expect(reduce(state, "checkpoint.restored", restored, { authority: "tool" })).toBe(state);
    expect(reduce(state, "checkpoint.restored", { ...restored, status: "sealed" })).toBe(state);
    expect(reduce(state, "checkpoint.restored", { malformed: true })).toBe(state);
  });

  it("tracks only runtime-owned processes for the active run", () => {
    const state = initial();
    const spawned = reduce(state, "process.spawned", { processId: "process", executionId: "exec" });
    expect(spawned.activeProcessIds).toEqual(["process"]);
    expect(reduce(spawned, "process.spawned", { processId: "process" })).toBe(spawned);
    expect(reduce(state, "process.spawned", { processId: "" })).toBe(state);
    expect(reduce(state, "process.spawned", { processId: 1 })).toBe(state);
    expect(reduce(state, "process.spawned", { processId: "other" }, { runId: "other" })).toBe(state);
    expect(reduce(state, "process.spawned", { processId: "other" }, { authority: "tool" })).toBe(state);

    expect(reduce(spawned, "process.exited", { processId: "process" }).activeProcessIds).toEqual([]);
    expect(reduce(spawned, "process.lost", { processId: "process" }).activeProcessIds).toEqual([]);
    expect(reduce(spawned, "process.exited", { processId: 1 })).toBe(spawned);
    expect(reduce(spawned, "process.exited", { processId: "process" }, { authority: "tool" }))
      .toBe(spawned);
  });
});
