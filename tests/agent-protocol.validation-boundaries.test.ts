import { describe, expect, it } from "vitest";
import {
  AgentEventValidationError,
  SnapshotValidationError,
  SNAPSHOT_SCHEMA_VERSION,
  assertAgentEventEnvelope,
  assertMcpPersistentEffectsAllowed,
  assertMcpWriteRootsEmpty,
  assertSnapshotEnvelope,
  isAgentEventEnvelope,
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
    expect(() => assertSnapshotEnvelope({ schemaVersion: 4 })).toThrow(/sessionId/u);
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

  it("requires event V7 for durable tool-result pruning boundaries", () => {
    const current = validAgentEventFixture("context.tool_results_pruned");
    expect(isAgentEventEnvelope(current)).toBe(true);
    expect(isAgentEventEnvelope({ ...current, schemaVersion: 6 })).toBe(false);
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
    // V9 deliberately treats the plan as low-friction working memory. A
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

  it("accepts a complete current snapshot and rejects legacy snapshots at the public boundary", () => {
    expect(isSnapshotEnvelope({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: 5, sessionId: "session", seq: 0,
      createdAt: fixtureOccurredAt, state: { ok: true }
    })).toBe(true);
    expect(isSnapshotEnvelope({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1, storeLayoutVersion: 5, sessionId: "session", seq: 0,
      createdAt: fixtureOccurredAt, state: { ok: true }
    })).toBe(false);
  });
});
