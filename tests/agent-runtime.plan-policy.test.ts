import { describe, expect, it } from "vitest";
import type { EvidenceRecord, PlanGraph } from "../packages/agent-protocol/src/index.js";
import { assertPlanTransition } from "../packages/agent-runtime/src/plan-policy.js";

const evidence: EvidenceRecord = {
  evidenceId: "evidence",
  sessionId: "session",
  runId: "run",
  kind: "diagnostic",
  status: "informational",
  createdAt: "2026-01-01T00:00:00.000Z",
  producer: { authority: "tool", id: "read" },
  summary: "checked",
  data: { source: "read", diagnostic: { ok: true } }
};

function base(): PlanGraph {
  return {
    revision: 1,
    goal: "safe plan",
    activeNodeId: "root",
    nodes: [{
      id: "root", title: "root", dependencies: [], status: "in_progress",
      owner: { kind: "root" }, acceptanceCriteria: ["done"], evidence: []
    }]
  };
}

describe("durable Plan transition policy", () => {
  it("requires exact non-failed evidence kind when completing", () => {
    const previous = base();
    const completed = {
      ...previous,
      revision: 2,
      activeNodeId: undefined,
      nodes: [{ ...previous.nodes[0]!, status: "completed" as const,
        evidence: [{ evidenceId: "evidence", kind: "validation" as const }] }]
    };
    expect(() => assertPlanTransition(previous, completed, new Map([[evidence.evidenceId, evidence]]), false))
      .toThrow(/mismatched evidence/iu);
    const failed = { ...evidence, status: "failed" as const };
    completed.nodes[0]!.evidence[0]!.kind = "diagnostic";
    expect(() => assertPlanTransition(previous, completed, new Map([[failed.evidenceId, failed]]), false))
      .toThrow(/failed/iu);
  });

  it("rejects running a node before its dependencies complete", () => {
    const previous = base();
    const next: PlanGraph = {
      revision: 2,
      goal: previous.goal,
      activeNodeId: "second",
      nodes: [
        { ...previous.nodes[0]!, status: "pending" },
        { id: "second", title: "second", dependencies: ["root"], status: "in_progress",
          owner: { kind: "root" }, acceptanceCriteria: ["done"], evidence: [] }
      ]
    };
    expect(() => assertPlanTransition(previous, next, new Map(), false)).toThrow(/dependencies complete/iu);
  });

  it("allows only runtime transitions for active child-owned nodes", () => {
    const previous = base();
    previous.activeNodeId = undefined;
    previous.nodes[0] = { ...previous.nodes[0]!, owner: { kind: "child", childId: "child" } };
    const next = structuredClone(previous);
    next.revision = 2;
    next.nodes[0]!.status = "blocked";
    next.nodes[0]!.blockedReason = "child failed";
    expect(() => assertPlanTransition(previous, next, new Map(), false)).toThrow(/only be changed by the runtime/iu);
    expect(() => assertPlanTransition(previous, next, new Map(), true)).not.toThrow();
  });

  it("does not allow a completed node to rewrite its durable evidence", () => {
    const previous = base();
    previous.activeNodeId = undefined;
    previous.nodes[0] = {
      ...previous.nodes[0]!,
      status: "completed",
      evidence: [{ evidenceId: evidence.evidenceId, kind: evidence.kind }]
    };
    const next = structuredClone(previous);
    next.revision = 2;
    next.nodes[0]!.evidence = [{ evidenceId: "different-evidence", kind: "diagnostic" }];
    expect(() => assertPlanTransition(previous, next, new Map(), false))
      .toThrow("cannot be modified without reopening");
  });
});
