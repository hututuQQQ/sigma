import { describe, expect, it } from "vitest";
import {
  createBudgetLedger,
  isAgentEventEnvelope,
  isBudgetLedgerState,
  isCheckpointRef,
  isEvidenceRecord,
  isPlanGraph,
  isUsageRecord,
  validateAgentEventEnvelope,
  type EvidenceRecord,
} from "../packages/agent-protocol/src/index.js";
import {
  dateTimeSchema,
  evidenceKindSchema,
} from "../packages/agent-protocol/src/domain-schemas.js";
import {
  agentEventPayloadFixtures,
  checkpointFixture,
  fixtureOccurredAt,
  usageFixture,
  validAgentEventFixture,
} from "./testkit/agent-event-fixtures.js";

function diagnosticEvidence(): Record<string, unknown> {
  return {
    evidenceId: "evidence", sessionId: "session", runId: "run", kind: "diagnostic",
    status: "passed", createdAt: fixtureOccurredAt, producer: { authority: "runtime" },
    summary: "checked", data: { source: "test", diagnostic: { ok: true } },
  };
}

function evidenceVariants(): EvidenceRecord[] {
  const base = {
    evidenceId: "evidence", sessionId: "session", runId: "run", status: "passed" as const,
    createdAt: fixtureOccurredAt, producer: { authority: "runtime" as const }, summary: "checked",
  };
  return [
    { ...base, kind: "workspace_delta", data: {
      delta: { added: [], modified: [], deleted: [] }, checkpointId: "checkpoint",
    } },
    { ...base, kind: "repository_delta", data: {
      operationCount: 1, operations: ["add"],
      beforeStateDigest: "a".repeat(64), afterStateDigest: "b".repeat(64),
      headBefore: null, headAfter: "c".repeat(40),
      refsBeforeDigest: "a".repeat(64), refsAfterDigest: "b".repeat(64),
      indexBeforeDigest: "a".repeat(64), indexAfterDigest: "b".repeat(64),
      reachableObjectsBefore: 0, reachableObjectsAfter: 1,
    } },
    { ...base, kind: "command", data: { command: "pnpm test", exitCode: 0 } },
    { ...base, kind: "validation", data: {
      validator: "test", frontierRevision: 1,
      stateDigest: "a".repeat(64), coveredPaths: []
    } },
    { ...base, kind: "diagnostic", data: { source: "test", diagnostic: null } },
    { ...base, kind: "review", data: {
      reviewerId: "reviewer", verdict: "approved", findings: [],
      frontierRevision: 1, stateDigest: "a".repeat(64),
    } },
    { ...base, kind: "checkpoint", data: {
      checkpointId: "checkpoint", checkpointStatus: "open", preManifestDigest: "digest",
    } },
    { ...base, kind: "child_outcome", data: {
      childId: "child", outcome: "completed", planNodeIds: [],
    } },
    { ...base, kind: "user_waiver", producer: { authority: "user" }, data: {
      scope: "review", reason: "explicit",
    } },
  ];
}

function eventWithPayload(type: keyof typeof agentEventPayloadFixtures, payload: unknown) {
  return { ...validAgentEventFixture(type), payload };
}

function setPath(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  const copy = structuredClone(value);
  let target = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) target = target[part] as Record<string | number, unknown>;
  target[path.at(-1)!] = replacement;
  return copy;
}

function expectEventValues(
  type: keyof typeof agentEventPayloadFixtures,
  path: readonly (string | number)[],
  values: readonly unknown[],
) {
  for (const value of values) {
    const payload = setPath(agentEventPayloadFixtures[type], path, value);
    expect(isAgentEventEnvelope(eventWithPayload(type, payload)), `${type}.${path.join(".")}=${String(value)}`)
      .toBe(true);
  }
}

describe("protocol enum and invariant contracts", () => {
  it("accepts every evidence, authority, usage, and checkpoint variant", () => {
    for (const evidence of evidenceVariants()) expect(isEvidenceRecord(evidence), evidence.kind).toBe(true);
    for (const status of ["passed", "failed", "warning", "informational"]) {
      expect(isEvidenceRecord({ ...diagnosticEvidence(), status }), status).toBe(true);
    }
    for (const authority of ["system", "developer", "user", "project", "runtime", "tool"]) {
      expect(isEvidenceRecord({
        ...diagnosticEvidence(), producer: { authority },
      }), authority).toBe(true);
      expect(isAgentEventEnvelope({
        ...validAgentEventFixture("diagnostic"), authority,
      }), `event authority ${authority}`).toBe(true);
    }
    for (const role of ["orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"]) {
      expect(isUsageRecord({ ...usageFixture(), role }), role).toBe(true);
    }
    for (const tokenizerAccuracy of ["exact", "approximate"]) {
      expect(isUsageRecord({ ...usageFixture(), tokenizerAccuracy }), tokenizerAccuracy).toBe(true);
    }
    expect(isUsageRecord({ ...usageFixture(), tokenizerAssetDigest: "a".repeat(64) })).toBe(true);
    for (const tokenizerAssetDigest of [
      "a", `x${"a".repeat(64)}`, `${"a".repeat(64)}x`, "g".repeat(64),
    ]) {
      expect(isUsageRecord({ ...usageFixture(), tokenizerAssetDigest }), tokenizerAssetDigest).toBe(false);
    }
    expect(dateTimeSchema.safeParse("not-a-date").error?.issues[0]?.message)
      .toBe("Expected an ISO-compatible date-time string");
    for (const status of ["open", "sealed", "restored"] as const) {
      expect(isCheckpointRef(checkpointFixture(status)), status).toBe(true);
    }
  });

  it("accepts every nested evidence and budget variant", () => {
    const review = evidenceVariants().find((item) => item.kind === "review")!;
    for (const verdict of ["approved", "changes_requested"]) {
      expect(isEvidenceRecord({ ...review, data: { ...review.data, verdict } }), verdict).toBe(true);
    }
    const checkpoint = evidenceVariants().find((item) => item.kind === "checkpoint")!;
    for (const checkpointStatus of ["open", "sealed", "restored"]) {
      expect(isEvidenceRecord({
        ...checkpoint, data: { ...checkpoint.data, checkpointStatus },
      }), checkpointStatus).toBe(true);
    }
    const child = evidenceVariants().find((item) => item.kind === "child_outcome")!;
    for (const outcome of ["completed", "failed", "cancelled", "blocked"]) {
      expect(isEvidenceRecord({ ...child, data: { ...child.data, outcome } }), outcome).toBe(true);
    }
    const waiver = evidenceVariants().find((item) => item.kind === "user_waiver")!;
    for (const scope of ["review", "validation"]) {
      expect(isEvidenceRecord({ ...waiver, data: { ...waiver.data, scope } }), scope).toBe(true);
    }
    for (const status of ["reserved", "committed", "released"]) {
      const ledger = createBudgetLedger();
      ledger.reservations.push({
        reservationId: "reservation", ownerId: "owner", status: status as "reserved",
        requested: { ...ledger.consumed }, consumed: { ...ledger.consumed }, createdAt: fixtureOccurredAt,
      });
      expect(isBudgetLedgerState(ledger), status).toBe(true);
    }
  });

  it("accepts all plan states, owners, and non-cyclic dependency shapes", () => {
    const evidence = [{ evidenceId: "evidence", kind: "diagnostic" as const }];
    const node = {
      id: "node", title: "work", dependencies: [], status: "pending" as const,
      owner: { kind: "root" as const }, acceptanceCriteria: [], evidence: [],
    };
    const nodes = [
      node,
      { ...node, status: "in_progress" as const },
      { ...node, status: "blocked" as const, blockedReason: "dependency" },
      { ...node, status: "completed" as const, evidence },
      { ...node, status: "cancelled" as const },
      { ...node, owner: { kind: "child" as const, childId: "child" } },
    ];
    for (const candidate of nodes) {
      expect(isPlanGraph({ revision: 1, goal: "goal", activeNodeId: "node", nodes: [candidate] }))
        .toBe(true);
    }
    const sharedDependency = [
      { ...node, id: "a", dependencies: ["c"] },
      { ...node, id: "b", dependencies: ["c"] },
      { ...node, id: "c" },
    ];
    expect(isPlanGraph({ revision: 1, goal: "goal", nodes: sharedDependency })).toBe(true);
    for (const kind of [
      "workspace_delta", "repository_delta", "command", "validation", "diagnostic",
      "review", "checkpoint", "child_outcome", "user_waiver",
    ]) {
      expect(evidenceKindSchema.safeParse(kind).success, kind).toBe(true);
      expect(isPlanGraph({
        revision: 1, goal: "goal", nodes: [{
          ...node, status: "completed", evidence: [{ evidenceId: "evidence", kind }],
        }],
      }), kind).toBe(true);
    }
  });

  it("accepts every event payload enum variant", () => {
    expectEventValues("session.created", ["mode"], ["analyze", "change"]);
    expectEventValues("run.started", ["mode"], ["analyze", "change"]);
    expectEventValues("run.failed", ["kind"], ["recoverable_failure", "fatal"]);
    const limitedCompletion = {
      kind: "completed_with_limitations",
      message: "done with a constraint",
      evidence: [],
      limitations: [{
        kind: "validation_capability_unavailable",
        claim: "unit",
        attemptedCommandSummary: "pnpm test",
        capabilityEvidenceId: "validation-proof",
        reason: "The test runner is unavailable."
      }],
      coordinator: {
        modelStopped: true,
        assuranceSatisfied: false,
        reviewSatisfied: true,
        limitationsAccepted: true,
        runCompleted: true
      },
      outcomeRevision: 1
    };
    expect(isAgentEventEnvelope(eventWithPayload("run.completed", limitedCompletion))).toBe(true);
    expect(isAgentEventEnvelope(eventWithPayload("run.completed", {
      ...limitedCompletion,
      coordinator: { ...limitedCompletion.coordinator, reviewSatisfied: false }
    }))).toBe(true);
    expect(isAgentEventEnvelope(eventWithPayload("run.completed", {
      ...limitedCompletion,
      coordinator: { ...limitedCompletion.coordinator, assuranceSatisfied: true }
    }))).toBe(false);
    const completed = {
      kind: "completed",
      message: "done",
      evidence: [],
      coordinator: {
        modelStopped: true,
        assuranceSatisfied: true,
        reviewSatisfied: false,
        runCompleted: true
      },
      outcomeRevision: 1
    };
    expect(isAgentEventEnvelope(eventWithPayload("run.completed", completed))).toBe(true);
    expect(isAgentEventEnvelope(eventWithPayload("run.completed", {
      ...completed,
      coordinator: { ...completed.coordinator, reviewSatisfied: "false" }
    }))).toBe(false);
    expectEventValues("user.follow_up", ["status"], ["queued", "delivered"]);
    expectEventValues("model.completed", ["finishReason"], [
      "stop", "length", "tool_calls", "content_filter", "protocol_error",
    ]);
    expectEventValues("model.completed", ["message", "role"], [
      "system", "developer", "user", "assistant", "tool",
    ]);
    expectEventValues("tool.approval_resolved", ["decision"], [
      "allow", "deny", "always_allow", "cancelled", "superseded",
    ]);
    expectEventValues("process.spawned", ["mode"], ["pipe", "pty", "background"]);
    expectEventValues("process.output", ["stream"], ["stdout", "stderr"]);
    expectEventValues("checkpoint.recovery_resolved", ["decision"], ["restore", "keep"]);
    expectEventValues("profile.resolved", ["source"], ["home", "workspace", "builtin"]);
    expectEventValues("skill.loaded", ["source"], ["home", "workspace", "builtin"]);
    expectEventValues("hook.completed", ["outcome", "status"], ["allowed", "denied", "observed", "failed"]);
    expectEventValues("context.compacted", ["item", "authority"], [
      "system", "developer", "user", "project", "runtime", "tool",
    ]);
    expectEventValues("budget.overrun", ["dimensions", 0, "dimension"], [
      "inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children",
    ]);
  });

  it("accepts every tool effect and execution-plan policy variant", () => {
    const effects = [
      "filesystem.read", "filesystem.write", "process.spawn", "process.spawn.readonly",
      "agent.spawn", "network", "validation", "outcome.propose", "outcome.request_input",
      "runtime.control", "checkpoint.restore", "destructive", "open_world",
    ];
    expectEventValues("tool.approval_requested", ["effects"], effects.map((effect) => [effect]));
    expectEventValues("tool.approval_requested", ["plan", "exactEffects"], effects.map((effect) => [effect]));
    expectEventValues("tool.approval_requested", ["plan", "network"], ["none", "full"]);
    expectEventValues("tool.approval_requested", ["plan", "processMode"], ["none", "pipe", "pty", "background"]);
    expectEventValues("tool.approval_requested", ["plan", "idempotence"], [
      "read_only", "replay_safe", "non_replayable",
    ]);
    expectEventValues("tool.completed", ["outcome", "status"], ["succeeded", "failed"]);
    expectEventValues("tool.completed", ["observedEffects"], effects.map((effect) => [effect]));
  });

  it("accepts every diagnostic union and optional literal contract", () => {
    const item = agentEventPayloadFixtures["context.compacted"].item;
    const diagnostics = [
      { kind: "steering.restart", turnId: 1, effectRevision: 0 },
      { kind: "child.join_failed", failures: [], evidence: [] },
      { kind: "nested_instructions_loaded", callId: "call", provenance: [], items: [item], affectsMutation: false },
      { kind: "hook_context_added", event: "pre_model", items: [item] },
      { kind: "recovery.retry_model", message: "retry" },
      { kind: "recovery.reset_tool", callId: "call", approval: "not_required" },
      {
        kind: "hook_model_recovered", hookId: "hook", event: "pre_model", requestId: "request",
        reservationId: "reservation", policy: "commit_full_no_replay",
      },
    ];
    for (const payload of diagnostics) {
      expect(isAgentEventEnvelope(eventWithPayload("diagnostic", payload)), payload.kind).toBe(true);
    }
    expect(isAgentEventEnvelope(eventWithPayload("run.suspended", {
      ...agentEventPayloadFixtures["run.suspended"], choices: ["restore", "keep"],
    }))).toBe(true);
    for (const type of ["tool.approval_requested", "tool.approval_resolved"] as const) {
      expect(isAgentEventEnvelope(eventWithPayload(type, {
        ...agentEventPayloadFixtures[type], delegated: true,
      }))).toBe(true);
    }
  });

  it("rejects emptied nested schemas and invalid optional object shapes", () => {
    const invalid = [
      eventWithPayload("model.completed", {
        ...agentEventPayloadFixtures["model.completed"], message: {},
      }),
      eventWithPayload("model.completed", {
        ...agentEventPayloadFixtures["model.completed"], toolCalls: [{}],
      }),
      eventWithPayload("tool.approval_requested", {
        ...agentEventPayloadFixtures["tool.approval_requested"], plan: {},
      }),
      eventWithPayload("tool.approval_requested", {
        ...agentEventPayloadFixtures["tool.approval_requested"],
        plan: { ...agentEventPayloadFixtures["tool.approval_requested"].plan, checkpointAction: {} },
      }),
      eventWithPayload("tool.completed", {
        ...agentEventPayloadFixtures["tool.completed"], artifactRefs: [{}],
      }),
      eventWithPayload("tool.completed", {
        ...agentEventPayloadFixtures["tool.completed"],
        runtimeAdvisories: [{
          schemaVersion: 1,
          code: "no_progress",
          repeatCount: 2,
          unchangedDimensions: ["workspace"],
          repair: { kind: "change_action_or_converge", suggestions: ["validate_or_finish"] },
        }],
      }),
    ];
    for (const value of invalid) expect(isAgentEventEnvelope(value)).toBe(false);
  });

  it("preserves exact structured issues for each plan and scope invariant", () => {
    const node = {
      id: "node", title: "work", dependencies: [], status: "pending",
      owner: { kind: "root" }, acceptanceCriteria: [], evidence: [],
    };
    const cases = [
      [{ revision: 1, goal: "goal", nodes: [{ ...node, status: "blocked" }] },
        ["payload", "plan", "nodes", 0, "blockedReason"], "Blocked plan nodes require a reason"],
      [{ revision: 1, goal: "goal", nodes: [{ ...node, status: "completed" }] },
        ["payload", "plan", "nodes", 0, "evidence"], "Completed plan nodes require evidence"],
      [{ revision: 1, goal: "goal", activeNodeId: "missing", nodes: [node] },
        ["payload", "plan", "activeNodeId"], "Active plan node does not exist"],
      [{ revision: 1, goal: "goal", nodes: [node, { ...node }] },
        ["payload", "plan", "nodes"], "Plan node identifiers must be unique"],
      [{ revision: 1, goal: "goal", nodes: [{ ...node, dependencies: ["missing"] }] },
        ["payload", "plan", "nodes", 0, "dependencies"], "Plan dependency does not exist"],
      [{ revision: 1, goal: "goal", nodes: [
        { ...node, id: "a", dependencies: ["b"] }, { ...node, id: "b", dependencies: ["a"] },
      ] }, ["payload", "plan", "nodes"], "Plan dependencies must be acyclic"],
    ] as const;
    for (const [plan, path, message] of cases) {
      expect(validateAgentEventEnvelope(eventWithPayload("plan.updated", {
        previousRevision: 0, plan,
      }))).toContainEqual({ path, code: "custom", message });
    }
    const scopeCases = [
      [{ ...validAgentEventFixture("checkpoint.recovery_resolved"), authority: "runtime" },
        { path: ["authority"], code: "invalid_authority", message: "Checkpoint recovery requires user authority" }],
      [{ ...validAgentEventFixture("budget.limit_increased"), authority: "runtime" },
        { path: ["authority"], code: "invalid_authority", message: "Budget increases require user authority" }],
      [eventWithPayload("evidence.recorded", { ...diagnosticEvidence(), runId: "other" }),
        { path: ["payload"], code: "invalid_scope", message: "Evidence scope must match its event envelope" }],
    ] as const;
    for (const [value, issue] of scopeCases) expect(validateAgentEventEnvelope(value)).toEqual([issue]);
  });
});
