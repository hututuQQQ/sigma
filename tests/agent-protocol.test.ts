import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES, SNAPSHOT_SCHEMA_VERSION, STORE_LAYOUT_VERSION, AgentEventValidationError,
  assertAgentEventEnvelope, assertEvidenceRecord, assertMcpPersistentEffectsAllowed,
  assertMcpWriteRootsEmpty, assertSnapshotEnvelope, createBudgetLedger, createEmptyPlan,
  evidenceSupportsClaim, isAgentEventEnvelope, isBudgetLedgerState, isCheckpointRef,
  isCompletionEligibleEvidence, isCompletionReferenceableEvidence,
  isEvidenceRecord, isJsonValue,
  isPlanGraph, isSnapshotEnvelope, isSolverVisibleAuthority, isUsageRecord, McpCapabilityPolicyError,
  SnapshotValidationError, SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1, type AgentEventType,
  type ValidationEvidence
} from "../packages/agent-protocol/src/index.js";
import {
  agentEventPayloadFixtures as fixtures, checkpointFixture, evidenceFixture, fixtureOccurredAt,
  usageFixture, validAgentEventFixture
} from "./testkit/agent-event-fixtures.js";

describe("AgentEventEnvelope V4 runtime boundary", () => {
  it("accepts a producer fixture for every declared durable event", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...AGENT_EVENT_TYPES].sort());
    for (const type of AGENT_EVENT_TYPES) expect(isAgentEventEnvelope(validAgentEventFixture(type)), type).toBe(true);
  });

  it("fails closed for unknown types, missing fields, extra fields, and wrong optional fields", () => {
    expect(isAgentEventEnvelope({ ...validAgentEventFixture(), type: "unknown" })).toBe(false);
    expect(isAgentEventEnvelope({ ...validAgentEventFixture(), unexpected: true })).toBe(false);
    for (const type of AGENT_EVENT_TYPES) {
      const payload = fixtures[type] as Record<string, unknown>;
      const missingRequired = Object.keys(payload).some((candidate) => !isAgentEventEnvelope({
        ...validAgentEventFixture(type),
        payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== candidate))
      }));
      expect(missingRequired, `${type} must have at least one required field`).toBe(true);
      expect(isAgentEventEnvelope({ ...validAgentEventFixture(type), payload: { ...payload, unexpected: true } })).toBe(false);
    }
    const badOptionals = [
      { ...validAgentEventFixture("evidence.recorded"), payload: {
        ...evidenceFixture(), producer: { authority: "runtime", id: 1 }
      } },
      { ...validAgentEventFixture("evidence.recorded"), payload: {
        ...evidenceFixture(), kind: "command", data: { command: "pnpm test", exitCode: 0, signal: 123 }
      } },
      { ...validAgentEventFixture("evidence.recorded"), payload: {
        ...evidenceFixture(), kind: "command", data: { command: "pnpm test", exitCode: 0, stdoutArtifactId: 1 }
      } },
      { ...validAgentEventFixture("review.completed"), payload: {
        ...evidenceFixture("review"), data: { ...evidenceFixture("review").data, checkpointId: 1 }
      } },
      { ...validAgentEventFixture("review.completed"), payload: {
        ...evidenceFixture("review"), data: { ...evidenceFixture("review").data, failureKind: "unknown" }
      } },
      { ...validAgentEventFixture("checkpoint.created"), payload: {
        ...checkpointFixture("open"), postManifestDigest: 1
      } }
    ];
    for (const value of badOptionals) expect(isAgentEventEnvelope(value)).toBe(false);
  });

  it("returns structured field paths from the shared assertion boundary", () => {
    try {
      assertAgentEventEnvelope({
        ...validAgentEventFixture("process.exited"),
        payload: { ...fixtures["process.exited"], signal: 123 }
      });
      expect.fail("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentEventValidationError);
      expect(error).toMatchObject({ code: "invalid_agent_event_envelope" });
      expect((error as AgentEventValidationError).issues[0]?.path).toEqual(["payload", "signal"]);
    }
  });

  it("persists structured tool results without relying on the text projection", () => {
    const event = validAgentEventFixture("tool.completed");
    expect(isAgentEventEnvelope({
      ...event,
      payload: {
        ...event.payload,
        result: { status: "rejected", code: "review_evidence_required", nextActions: [{ tool: "request_review" }] }
      }
    })).toBe(true);
    expect(isAgentEventEnvelope({
      ...event,
      payload: { ...event.payload, result: { invalid: undefined } }
    })).toBe(false);
  });

  it("persists typed retryable reviewer failures", () => {
    const event = validAgentEventFixture("review.completed");
    expect(isAgentEventEnvelope({
      ...event,
      payload: {
        ...event.payload,
        status: "failed",
        data: {
          ...(event.payload as { data: Record<string, unknown> }).data,
          verdict: "changes_requested",
          failureKind: "infrastructure"
        }
      }
    })).toBe(true);
  });

  it("rejects wrong versions and authority/scope violations", () => {
    expect(isAgentEventEnvelope({ ...validAgentEventFixture(), schemaVersion: 3 })).toBe(false);
    expect(isAgentEventEnvelope({ ...validAgentEventFixture(), authority: "external_verifier" })).toBe(false);
    expect(isAgentEventEnvelope({
      ...validAgentEventFixture("checkpoint.recovery_resolved"), authority: "runtime"
    })).toBe(false);
    expect(isAgentEventEnvelope({
      ...validAgentEventFixture("evidence.recorded"), payload: { ...evidenceFixture(), runId: "other" }
    })).toBe(false);
    expect(isSolverVisibleAuthority("external_verifier")).toBe(false);
  });

  it("validates strict V4 snapshots independently", () => {
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, storeLayoutVersion: STORE_LAYOUT_VERSION,
      sessionId: "session", seq: 1, createdAt: fixtureOccurredAt, state: { value: 1 }
    };
    expect(isSnapshotEnvelope(snapshot)).toBe(true);
    expect(isSnapshotEnvelope({ ...snapshot, schemaVersion: 3 })).toBe(false);
    expect(isSnapshotEnvelope({ ...snapshot, extra: true })).toBe(false);
    expect(() => assertSnapshotEnvelope({ ...snapshot, createdAt: "invalid" })).toThrow(SnapshotValidationError);
  });

  it("validates all evidence optional fields strictly", () => {
    const command = {
      evidenceId: "command", sessionId: "session", runId: "run", kind: "command", status: "passed",
      createdAt: fixtureOccurredAt, producer: { authority: "tool", id: "process" }, summary: "ran",
      data: {
        command: "pnpm test", exitCode: 0, signal: "SIGTERM", artifactIds: ["artifact"],
        stdoutArtifactId: "stdout", stderrArtifactId: "stderr"
      }
    };
    expect(isEvidenceRecord(command)).toBe(true);
    for (const [field, value] of [["signal", 123], ["stdoutArtifactId", 123], ["stderrArtifactId", 123]]) {
      expect(isEvidenceRecord({ ...command, data: { ...command.data, [field]: value } })).toBe(false);
    }
    const validation = {
      ...command, kind: "validation", data: {
        validator: "tests", command: "pnpm test", exitCode: 0, artifactIds: [], workspaceDeltaEvidenceIds: []
      }
    };
    expect(isEvidenceRecord(validation)).toBe(true);
    expect(isEvidenceRecord({ ...validation, data: { ...validation.data, exitCode: "zero" } })).toBe(false);
    expect(() => assertEvidenceRecord({ ...command, data: { ...command.data, signal: 123 } })).toThrow();
  });

  it("keeps provenance attestations durable but ineligible for task completion", () => {
    const diagnostic = evidenceFixture();
    expect(isCompletionEligibleEvidence(diagnostic, "session", "run")).toBe(true);
    expect(isCompletionEligibleEvidence({
      ...diagnostic,
      data: { ...diagnostic.data, source: SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1 }
    }, "session", "run")).toBe(false);
    expect(isCompletionEligibleEvidence({ ...diagnostic, status: "failed" }, "session", "run")).toBe(false);
    expect(isCompletionEligibleEvidence(diagnostic, "session", "other-run")).toBe(false);
  });

  it("types failed validation as executed evidence without treating it as passed", () => {
    const failed: ValidationEvidence = {
      evidenceId: "failed-validation",
      sessionId: "session",
      runId: "run",
      kind: "validation",
      status: "failed",
      createdAt: fixtureOccurredAt,
      producer: { authority: "tool", id: "validate" },
      summary: "tests exited 1",
      data: {
        validator: "command",
        command: "pnpm test",
        exitCode: 1,
        termination: {
          processStarted: true,
          state: "exited",
          exitCode: 1,
          signal: null,
          timedOut: false,
          idleTimedOut: false,
          cancelled: false
        },
        artifactIds: [],
        workspaceDeltaEvidenceIds: ["delta"],
        checkpointIds: ["checkpoint"]
      }
    };
    expect(isEvidenceRecord(failed)).toBe(true);
    expect(isCompletionEligibleEvidence(failed, "session", "run")).toBe(false);
    expect(isCompletionReferenceableEvidence(failed, "session", "run")).toBe(true);
    expect(evidenceSupportsClaim(failed, "validation_executed")).toBe(true);
    expect(evidenceSupportsClaim(failed, "validation_passed")).toBe(false);
    expect(evidenceSupportsClaim(failed, "acceptance_met")).toBe(false);

    const launchFailure: ValidationEvidence = {
      ...failed,
      evidenceId: "launch-failure",
      data: {
        ...failed.data,
        termination: {
          ...failed.data.termination!,
          processStarted: false,
          failureCode: "sandbox_launch_failed"
        }
      }
    };
    expect(evidenceSupportsClaim(launchFailure, "validation_executed")).toBe(false);
    expect(isCompletionReferenceableEvidence(launchFailure, "session", "run")).toBe(false);
  });

  it("keeps domain ledgers, topology, JSON, and MCP policy strict", () => {
    expect(isJsonValue([1, { ok: true }])).toBe(true);
    expect(isJsonValue({ bad: undefined })).toBe(false);
    expect(isUsageRecord(usageFixture())).toBe(true);
    expect(isUsageRecord({ ...usageFixture(), attempt: 0 })).toBe(false);
    expect(isBudgetLedgerState(createBudgetLedger())).toBe(true);
    expect(isPlanGraph(createEmptyPlan())).toBe(true);
    expect(isPlanGraph({ revision: 0, goal: "", activeNodeId: "missing", nodes: [] })).toBe(false);
    expect(isCheckpointRef(checkpointFixture("restored"))).toBe(true);
    expect(() => assertMcpPersistentEffectsAllowed("safe", ["filesystem.read", "network"])).not.toThrow();
    expect(() => assertMcpWriteRootsEmpty("safe", [])).not.toThrow();
    expect(() => assertMcpPersistentEffectsAllowed("unsafe", ["filesystem.write"]))
      .toThrow(McpCapabilityPolicyError);
  });

  it("keeps the fixture builder exhaustive at compile time", () => {
    const types: AgentEventType[] = Object.keys(fixtures) as AgentEventType[];
    expect(types).toHaveLength(AGENT_EVENT_TYPES.length);
  });
});
