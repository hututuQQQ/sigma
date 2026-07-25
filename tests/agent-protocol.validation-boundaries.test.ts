import { describe, expect, it } from "vitest";
import {
  AgentEventValidationError,
  SnapshotValidationError,
  SNAPSHOT_SCHEMA_VERSION,
  assertAgentEventEnvelope,
  assertMcpPersistentEffectsAllowed,
  assertMcpWriteRootsEmpty,
  assertSnapshotEnvelope,
  emptyRuntimePromptState,
  isAgentEventEnvelope,
  isRuntimePromptState,
  isSnapshotEnvelope,
  validateAgentEventEnvelope
} from "../packages/agent-protocol/src/index.js";
import {
  agentEventPayloadFixtures,
  evidenceFixture,
  fixtureOccurredAt,
  validAgentEventFixture
} from "./testkit/agent-event-fixtures.js";

function event(type: Parameters<typeof validAgentEventFixture>[0], changes: Record<string, unknown>) {
  return { ...validAgentEventFixture(type), ...changes };
}

function planEvent(plan: Record<string, unknown>) {
  return event("plan.updated", { payload: { previousRevision: 0, plan } });
}

describe("strict current-version validation boundaries", () => {
  it("reports root and nested paths in structured event and snapshot errors", () => {
    expect(() => assertAgentEventEnvelope(null)).toThrow(AgentEventValidationError);
    expect(validateAgentEventEnvelope(null)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: [] })
    ]));
    expect(() => assertSnapshotEnvelope(null)).toThrow(SnapshotValidationError);
    expect(isSnapshotEnvelope(null)).toBe(false);
    expect(() => assertSnapshotEnvelope({ schemaVersion: 999 })).toThrow(
      expect.objectContaining({
        code: "unsupported_schema_version",
        path: "schemaVersion",
        expected: 1,
        actual: 999
      })
    );
  });

  it("rejects every cross-envelope authority and scope violation", () => {
    expect(isAgentEventEnvelope(event("checkpoint.recovery_resolved", { authority: "runtime" }))).toBe(false);
    expect(isAgentEventEnvelope(event("budget.limit_increased", { authority: "runtime" }))).toBe(false);
    expect(isAgentEventEnvelope(event("evidence.recorded", {
      payload: { ...evidenceFixture(), sessionId: "another-session" }
    }))).toBe(false);
    expect(isAgentEventEnvelope(event("evidence.recorded", {
      authority: "tool",
      payload: { ...evidenceFixture(), producer: { authority: "runtime" } }
    }))).toBe(false);
    expect(isAgentEventEnvelope(event("review.completed", { authority: "user" }))).toBe(false);
    expect(isAgentEventEnvelope(event("review.waived", { authority: "runtime" }))).toBe(false);
    expect(isAgentEventEnvelope(event("evidence.recorded", {
      authority: "tool",
      payload: { ...evidenceFixture(), producer: { authority: "tool" } }
    }))).toBe(true);
  });

  it("requires schema 1 for durable tool-result pruning boundaries", () => {
    const current = validAgentEventFixture("context.tool_results_pruned");
    expect(isAgentEventEnvelope(current)).toBe(true);
    expect(isAgentEventEnvelope({ ...current, schemaVersion: 999 })).toBe(false);
  });

  it("accepts only the closed schema 1 runtime prompt state", () => {
    const digest = "a".repeat(64);
    const current = {
      ...emptyRuntimePromptState(),
      sectionDigests: { repository: digest },
      archiveSourceDigest: digest
    };
    expect(isRuntimePromptState(current)).toBe(true);
    expect(isRuntimePromptState({ ...current, schemaVersion: 999 })).toBe(false);
    expect(isRuntimePromptState({
      ...current,
      sectionDigests: { ...current.sectionDigests, unknown: digest }
    })).toBe(false);
    expect(isRuntimePromptState({
      ...current,
      sectionDigests: { repository: "not-a-digest" }
    })).toBe(false);
    expect(isRuntimePromptState({ ...current, budgetBand: 75 })).toBe(false);
    expect(isRuntimePromptState({ ...current, archiveSourceDigest: "not-a-digest" })).toBe(false);
  });

  it("enforces plan graph invariants and paired skill manifest fields", () => {
    const rootOwner = { kind: "root" };
    const node = {
      id: "node", title: "work", dependencies: [], status: "pending", owner: rootOwner,
      acceptanceCriteria: [], evidence: []
    };
    const invalidPlans = [
      { revision: 1, goal: "goal", nodes: [{ ...node, status: "blocked" }] },
      { revision: 1, goal: "goal", activeNodeId: "missing", nodes: [node] },
      { revision: 1, goal: "goal", nodes: [node, { ...node }] },
      { revision: 1, goal: "goal", nodes: [{ ...node, dependencies: ["missing"] }] },
      { revision: 1, goal: "goal", nodes: [
        { ...node, id: "a", dependencies: ["b"] }, { ...node, id: "b", dependencies: ["a"] }
      ] }
    ];
    for (const plan of invalidPlans) expect(isAgentEventEnvelope(planEvent(plan))).toBe(false);
    // The current plan is low-friction working memory. A
    // completed checklist item no longer needs to carry completion evidence;
    // validation and review are tracked in their own ledgers.
    expect(isAgentEventEnvelope(planEvent({
      revision: 1,
      goal: "goal",
      nodes: [{ ...node, status: "completed" }]
    }))).toBe(true);
    expect(isAgentEventEnvelope(event("skill.loaded", {
      payload: { ...agentEventPayloadFixtures["skill.loaded"], executionManifestArtifactId: "a".repeat(64) }
    }))).toBe(false);
  });

  it("fails closed for undeclared MCP capabilities and writable roots", () => {
    expect(() => assertMcpPersistentEffectsAllowed("server", undefined)).toThrow(/explicitly declare/u);
    expect(() => assertMcpPersistentEffectsAllowed("server", ["filesystem.write"])).toThrow(/forbidden/u);
    expect(() => assertMcpWriteRootsEmpty("server", ["."])).toThrow(/writable roots/u);
    expect(() => assertMcpPersistentEffectsAllowed("server", ["filesystem.read"])).not.toThrow();
    expect(() => assertMcpWriteRootsEmpty("server", [])).not.toThrow();
  });

  it("accepts a complete schema 1 snapshot and rejects an unknown schema", () => {
    expect(isSnapshotEnvelope({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, sessionId: "session", seq: 0,
      createdAt: fixtureOccurredAt, state: { ok: true }
    })).toBe(true);
    expect(isSnapshotEnvelope({
      schemaVersion: 999, sessionId: "session", seq: 0,
      createdAt: fixtureOccurredAt, state: { ok: true }
    })).toBe(false);
  });
});
