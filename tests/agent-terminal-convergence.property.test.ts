import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  createKernelState,
  evolve,
  type KernelState
} from "../packages/agent-kernel/src/index.js";

const NOW = "2026-07-23T00:00:00.000Z";

function initial(): KernelState {
  return createKernelState({
    sessionId: "property-session",
    runId: "property-run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-07-23T01:00:00.000Z"
  });
}

function apply(state: KernelState, type: AgentEventType, payload: JsonValue): KernelState {
  const event: AgentEventEnvelope = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: state.lastSeq + 1,
    eventId: `event-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: NOW,
    type,
    authority: "runtime",
    payload
  };
  return evolve(state, event);
}

function toolTurn(
  state: KernelState,
  turnId: number,
  name: "read" | "shell" | "exec",
  args: Record<string, JsonValue>,
  ok: boolean
): KernelState {
  let next = apply(state, "model.started", { turnId, effectRevision: state.revision });
  const modelTurn = next.activeModelTurn!;
  const callId = `call-${turnId}`;
  next = apply(next, "model.completed", {
    ...modelTurn,
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name, arguments: args }]
    },
    toolCalls: [{ id: callId, name, arguments: args }],
    finishReason: "tool_calls"
  });
  next = apply(next, ok ? "tool.completed" : "tool.failed", {
    callId,
    ...modelTurn,
    ok,
    output: ok ? "observed" : "failed",
    outcome: {
      status: ok ? "succeeded" : "failed",
      output: ok ? "observed" : "failed",
      diagnosticCodes: ok ? [] : ["command_failed"]
    },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: ok ? [] : ["command_failed"],
    startedAt: NOW,
    completedAt: NOW
  });
  return next;
}

describe("model-led convergence properties", () => {
  it("never semantically terminates any finite sequence of distinct observations", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        name: fc.constantFrom<"read" | "shell">("read", "shell"),
        ok: fc.boolean(),
        nonce: fc.integer()
      }), { maxLength: 80 }),
      (steps) => {
        let state = apply(initial(), "user.message", { text: "Investigate." });
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index]!;
          state = toolTurn(state, index + 1, step.name, {
            path: `observation-${index}-${step.nonce}`
          }, step.ok);
          expect(state.phase).toBe("ready_model");
          expect(state.proposedOutcome).toBeUndefined();
          expect(state.outcome).toBeUndefined();
          assertKernelInvariants(state);
        }
      }
    ), { numRuns: 100 });
  });

  it("does not create semantic recovery state after a failed exec receipt", () => {
    let state = apply(initial(), "user.message", { text: "Recover from the failure." });
    state = toolTurn(state, 1, "exec", { command: "missing" }, false);
    expect(state.phase).toBe("ready_model");
    expect(state).not.toHaveProperty("taskControl");
    expect(state.proposedOutcome).toBeUndefined();
    expect(state.outcome).toBeUndefined();
  });

  it("adds exactly one non-binding advisory on the third identical call", () => {
    let state = apply(initial(), "user.message", { text: "Inspect repeatedly if useful." });
    for (let turn = 1; turn <= 6; turn += 1) {
      state = toolTurn(state, turn, "read", { path: "same.txt" }, true);
      expect(state.phase).toBe("ready_model");
      expect(state.proposedOutcome).toBeUndefined();
    }
    const advisories = state.messages.filter((message) =>
      message.role === "developer" && message.content.includes("only an advisory"));
    expect(advisories).toHaveLength(1);
  });

  it("uses only explicit terminal tools for input and blocking", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0),
      (question) => {
        let state = apply(initial(), "user.message", { text: "Continue." });
        state = apply(state, "model.started", { turnId: 1, effectRevision: state.revision });
        const turn = state.activeModelTurn!;
        state = apply(state, "model.completed", {
          ...turn,
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "input",
              name: "request_user_input",
              arguments: { message: question }
            }]
          },
          toolCalls: [{
            id: "input",
            name: "request_user_input",
            arguments: { message: question }
          }],
          finishReason: "tool_calls"
        });
        state = apply(state, "tool.completed", {
          callId: "input",
          ...turn,
          ok: true,
          output: question,
          observedEffects: ["outcome.request_input"],
          artifacts: [],
          diagnostics: [],
          startedAt: NOW,
          completedAt: NOW
        });
        expect(state.proposedOutcome).toEqual({
          kind: "needs_input",
          requestId: "input",
          message: question.trim()
        });
        assertKernelInvariants(state);
      }
    ));
  });
});
