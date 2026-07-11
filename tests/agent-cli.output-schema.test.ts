import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import { outputError, outputEvent, outputResult } from "../packages/agent-cli/src/output-schema.js";

function event(type: AgentEventEnvelope["type"]): AgentEventEnvelope {
  return {
    schemaVersion: 3,
    seq: 1,
    eventId: "event",
    sessionId: "session",
    runId: "run",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    authority: "runtime",
    payload: { ok: true }
  };
}

describe("CLI output schema compatibility", () => {
  it("wraps V3 event/result/error records with explicit kinds", () => {
    expect(outputEvent(event("diagnostic"), 3)).toMatchObject({ schemaVersion: 3, kind: "event", type: "diagnostic" });
    expect(outputResult({ status: "completed" }, 3)).toMatchObject({ schemaVersion: 3, kind: "result", type: "result" });
    expect(outputError({ code: "failed", message: "no" }, 3)).toEqual({
      schemaVersion: 3, kind: "error", type: "error", error: { code: "failed", message: "no" }
    });
  });

  it("downcasts V3-only events to a V2 diagnostic without leaking a V3 envelope", () => {
    expect(outputEvent(event("model.started"), 2)).toMatchObject({ schemaVersion: 2, type: "model.started" });
    expect(outputEvent(event("review.completed"), 2)).toMatchObject({
      schemaVersion: 2,
      type: "diagnostic",
      payload: { kind: "v3_event", originalType: "review.completed" }
    });
    expect(outputResult({ status: "completed" }, 2)).toEqual({ type: "result", result: { status: "completed" } });
    expect(outputError({ code: "failed", message: "no" }, 2)).toEqual({
      type: "error", error: { code: "failed", message: "no" }
    });
  });
});
