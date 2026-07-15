import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import { outputError, outputEvent, outputJsonLines, outputResult } from "../packages/agent-cli/src/output-schema.js";

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
    const wrapped = outputEvent(event("diagnostic"), 3);
    expect(wrapped).toMatchObject({
      schemaVersion: 3, kind: "event", type: "diagnostic",
      payload: { ok: true }
    });
    expect(wrapped).not.toHaveProperty("event");
    expect(outputResult({ status: "completed" }, 3)).toMatchObject({ schemaVersion: 3, kind: "result", type: "result" });
    expect(outputError({ code: "failed", message: "no" }, 3)).toEqual({
      schemaVersion: 3, kind: "error", type: "error", error: { code: "failed", message: "no" }
    });
  });

  it("does not duplicate large event payloads in V3 JSONL envelopes", () => {
    const large = { ...event("model.completed"), payload: { text: "x".repeat(40_000) } };
    const encoded = JSON.stringify(outputEvent(large, 3));
    expect(encoded.length).toBeLessThan(50_000);
    expect(JSON.parse(encoded).payload.text).toHaveLength(40_000);
  });

  it("frames oversized JSONL records into independently bounded chunks", () => {
    const record = outputEvent({
      ...event("run.completed"),
      payload: { kind: "completed", message: "好".repeat(30_000) }
    }, 3);
    const lines = outputJsonLines(record, "large-event", 4_096);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => Buffer.byteLength(line, "utf8") <= 4_096)).toBe(true);
    const restored = Buffer.from(
      lines.map((line) => JSON.parse(line).data as string).join(""), "base64"
    ).toString("utf8");
    expect(JSON.parse(restored)).toEqual(record);
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
