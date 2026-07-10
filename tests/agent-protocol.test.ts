import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  assertAgentEventEnvelope,
  isAgentEventEnvelope,
  isJsonValue,
  isSolverVisibleAuthority
} from "../packages/agent-protocol/src/index.js";

function validEvent(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    seq: 1,
    eventId: "event",
    sessionId: "session",
    runId: "run",
    occurredAt: "2026-07-10T00:00:00.000Z",
    type: "diagnostic",
    authority: "runtime",
    payload: { nested: [true, 1, "text", null] }
  };
}

describe("AgentEventEnvelope runtime boundary", () => {
  it("accepts every declared event type and solver-visible authority", () => {
    for (const type of AGENT_EVENT_TYPES) expect(isAgentEventEnvelope({ ...validEvent(), type })).toBe(true);
    for (const authority of ["system", "developer", "user", "project", "runtime", "tool"]) {
      expect(isAgentEventEnvelope({ ...validEvent(), authority })).toBe(true);
      expect(isSolverVisibleAuthority(authority as "runtime")).toBe(true);
    }
    expect(isSolverVisibleAuthority("external_verifier")).toBe(false);
    expect(() => assertAgentEventEnvelope(validEvent())).not.toThrow();
  });

  it("rejects malformed, non-JSON, and evaluator-controlled envelopes", () => {
    const invalid: unknown[] = [
      null,
      [],
      { ...validEvent(), schemaVersion: 1 },
      { ...validEvent(), seq: 0 },
      { ...validEvent(), seq: 1.5 },
      { ...validEvent(), eventId: "" },
      { ...validEvent(), sessionId: "" },
      { ...validEvent(), runId: "" },
      { ...validEvent(), occurredAt: "not-a-date" },
      { ...validEvent(), type: "unknown" },
      { ...validEvent(), authority: "external_verifier" },
      { ...validEvent(), payload: undefined },
      { ...validEvent(), payload: Number.POSITIVE_INFINITY }
    ];
    for (const value of invalid) expect(isAgentEventEnvelope(value)).toBe(false);
    expect(() => assertAgentEventEnvelope(invalid[2])).toThrow("Invalid AgentEventEnvelope");
  });

  it("validates JSON recursively", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("text")).toBe(true);
    expect(isJsonValue(false)).toBe(true);
    expect(isJsonValue(0)).toBe(true);
    expect(isJsonValue([1, { ok: true }])).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue([() => undefined])).toBe(false);
    expect(isJsonValue({ bad: undefined })).toBe(false);
  });
});
