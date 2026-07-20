import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  assertAgentEventEnvelope,
  isAgentEventEnvelope,
  parseAgentEventPayload
} from "../packages/agent-protocol/src/index.js";
import {
  authorityForEvent,
  checkpointFixture,
  evidenceFixture,
  validAgentEventFixture
} from "./testkit/agent-event-fixtures.js";

const wrongString = fc.oneof(
  fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.integer()), fc.dictionary(fc.string(), fc.integer())
);
const wrongNullableNumber = fc.oneof(
  fc.string(), fc.boolean(), fc.array(fc.integer()), fc.dictionary(fc.string(), fc.integer())
);

function scopedEvent(type: (typeof AGENT_EVENT_TYPES)[number], seq: number, eventId: string): Record<string, unknown> {
  return {
    ...validAgentEventFixture(type),
    seq: type === "session.created" ? 1 : seq,
    authority: authorityForEvent(type),
    eventId
  };
}

function invalidOptional(type: string, field: string, value: unknown): Record<string, unknown> {
  if (type === "process.exited") {
    return { ...validAgentEventFixture(type), payload: { processId: "process", state: "exited", exitCode: 0, [field]: value } };
  }
  if (type === "checkpoint.created") {
    return { ...validAgentEventFixture(type), payload: { ...checkpointFixture("open"), [field]: value } };
  }
  const kind = type === "review.completed" ? "review" : type;
  const base = kind === "review" ? evidenceFixture("review") : {
    ...evidenceFixture(), kind, data: kind === "command"
      ? { command: "pnpm test", exitCode: 0 }
      : {
          validator: "tests", command: "pnpm test", exitCode: 0, artifactIds: [],
          frontierRevision: 1, stateDigest: "a".repeat(64), coveredPaths: []
        }
  };
  return {
    ...validAgentEventFixture(type === "review.completed" ? type : "evidence.recorded"),
    payload: { ...base, data: { ...base.data, [field]: value } }
  };
}

describe("V5 protocol properties", () => {
  it("round-trips every producer event through JSON and the consumer parser", () => {
    fc.assert(fc.property(
      fc.constantFrom(...AGENT_EVENT_TYPES),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      fc.uuid(),
      (type, seq, eventId) => {
        const encoded = JSON.stringify(scopedEvent(type, seq, eventId));
        const decoded: unknown = JSON.parse(encoded);
        expect(isAgentEventEnvelope(decoded)).toBe(true);
        assertAgentEventEnvelope(decoded);
        expect(() => parseAgentEventPayload(decoded.type, decoded.payload)).not.toThrow();
      }
    ), { numRuns: 300 });
  });

  it("rejects session.created outside the first runtime-authored event", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: Number.MAX_SAFE_INTEGER }),
      (seq) => {
        expect(isAgentEventEnvelope({ ...validAgentEventFixture("session.created"), seq })).toBe(false);
      }
    ), { numRuns: 100 });
    fc.assert(fc.property(
      fc.constantFrom("system", "developer", "user", "project", "tool"),
      (authority) => {
        expect(isAgentEventEnvelope({
          ...validAgentEventFixture("session.created"), authority
        })).toBe(false);
      }
    ), { numRuns: 100 });
  });

  it("rejects arbitrary non-string values in every known optional string gap", () => {
    const targets = [
      ["process.exited", "signal"], ["command", "signal"], ["command", "stdoutArtifactId"],
      ["command", "stderrArtifactId"], ["review.completed", "checkpointId"],
      ["checkpoint.created", "postManifestDigest"]
    ] as const;
    fc.assert(fc.property(fc.constantFrom(...targets), wrongString, ([type, field], value) => {
      expect(isAgentEventEnvelope(invalidOptional(type, field, value))).toBe(false);
    }), { numRuns: 300 });
  });

  it("rejects arbitrary non-number validation exit codes and unknown event types", () => {
    fc.assert(fc.property(wrongNullableNumber, (value) => {
      expect(isAgentEventEnvelope(invalidOptional("validation", "exitCode", value))).toBe(false);
    }), { numRuns: 100 });
    fc.assert(fc.property(
      fc.string().filter((value) => !(AGENT_EVENT_TYPES as readonly string[]).includes(value)),
      (type) => {
        expect(isAgentEventEnvelope({ ...validAgentEventFixture(), type })).toBe(false);
      }
    ), { numRuns: 200 });
  });
});
