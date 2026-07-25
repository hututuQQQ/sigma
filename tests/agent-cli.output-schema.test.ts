import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, AgentEventType } from "../packages/agent-protocol/src/index.js";
import {
  CLI_OUTPUT_SCHEMA_VERSION,
  outputError,
  outputEvent,
  outputJsonLines,
  outputResult
} from "../packages/agent-cli/src/output-schema.js";
import { validAgentEventFixture } from "./testkit/agent-event-fixtures.js";

function event(type: AgentEventType = "diagnostic"): AgentEventEnvelope {
  return validAgentEventFixture(type) as AgentEventEnvelope;
}

describe("CLI output", () => {
  it("wraps event, result, and error records in the current schema", () => {
    expect(CLI_OUTPUT_SCHEMA_VERSION).toBe(1);
    expect(outputEvent(event())).toMatchObject({
      schemaVersion: 1,
      kind: "event",
      type: "diagnostic"
    });
    expect(outputResult({ status: "completed" })).toMatchObject({
      schemaVersion: 1,
      kind: "result",
      type: "result"
    });
    expect(outputError({ code: "failed", message: "no" })).toEqual({
      schemaVersion: 1,
      kind: "error",
      type: "error",
      error: { code: "failed", message: "no" }
    });
  });

  it("does not duplicate large event payloads", () => {
    const large = {
      ...event("model.completed"),
      payload: { ...event("model.completed").payload, text: "x".repeat(40_000) }
    } as AgentEventEnvelope;
    const encoded = JSON.stringify(outputEvent(large));
    expect(encoded.length).toBeLessThan(50_000);
    expect((JSON.parse(encoded).payload as { text: string }).text).toHaveLength(40_000);
  });

  it("frames oversized JSONL records into independently bounded chunks", () => {
    const record = outputEvent({
      ...event("run.completed"),
      payload: { kind: "completed", message: "终".repeat(30_000) }
    } as AgentEventEnvelope);
    const lines = outputJsonLines(record, "large-event", 4_096);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => Buffer.byteLength(line, "utf8") <= 4_096)).toBe(true);
    const restored = Buffer.from(
      lines.map((line) => JSON.parse(line).data as string).join(""),
      "base64"
    ).toString("utf8");
    expect(JSON.parse(restored)).toEqual(record);
  });
});
