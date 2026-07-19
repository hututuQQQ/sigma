import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue,
  type ToolDescriptor,
  type ToolEffect
} from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  createKernelState,
  evolve,
  type KernelState
} from "../packages/agent-kernel/src/index.js";
import {
  terminalProtocolAction
} from "../packages/agent-tools/src/index.js";
import {
  descriptorAllowedForRepair,
  effectsAllowedForRepair
} from "../packages/agent-runtime/src/tool-turn-policy.js";

const NOW = "2026-01-01T00:00:00.000Z";
const nonBlankText = fc.string({ minLength: 1, maxLength: 80 })
  .filter((value) => value.trim().length > 0);

function initial(): KernelState {
  return createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-01-01T00:01:00.000Z"
  });
}

function event(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue = {}
): AgentEventEnvelope {
  return {
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
}

function apply(state: KernelState, type: AgentEventType, payload: JsonValue = {}): KernelState {
  return evolve(state, event(state, type, payload));
}

function startModel(state: KernelState, turnId: number): KernelState {
  return apply(state, "model.started", { turnId, effectRevision: state.revision });
}

function settleModel(
  state: KernelState,
  payload: Record<string, JsonValue>
): KernelState {
  if (!state.activeModelTurn) throw new Error("Property model turn is not active.");
  return apply(state, "model.completed", { ...payload, ...state.activeModelTurn });
}

function evidence(): EvidenceRecord {
  return {
    evidenceId: "property-evidence",
    sessionId: "session",
    runId: "run",
    kind: "diagnostic",
    status: "passed",
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: "property evidence",
    data: { source: "property", diagnostic: { ok: true } }
  };
}

function protectedAnswer(answer: string): KernelState {
  let state = apply({ ...initial(), mode: "analyze" }, "user.message", { text: "answer with evidence" });
  state = apply(state, "evidence.recorded", evidence());
  return settleModel(startModel(state, 1), {
    message: { role: "assistant", content: answer },
    toolCalls: [],
    finishReason: "stop"
  });
}

function descriptor(
  possibleEffects: ToolEffect[],
  maximumEffects?: ToolEffect[],
  name = "generated_terminal_tool"
): ToolDescriptor {
  return {
    name,
    description: "Generated terminal policy descriptor.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    possibleEffects,
    ...(maximumEffects ? { maximumEffects } : {}),
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval: "auto",
    idempotent: true,
    timeoutMs: 1_000
  };
}

describe("terminal convergence properties", () => {
  it("keeps every normal tool available during terminal correction", () => {
    const effects = fc.uniqueArray(fc.constantFrom<ToolEffect>(
      "outcome.propose",
      "outcome.request_input",
      "filesystem.read",
      "filesystem.write",
      "network"
    ), { maxLength: 5 });
    const names = fc.constantFrom("runtime_finalize", "request_user_input", "generated_terminal_tool");
    fc.assert(fc.property(effects, effects, effects, names,
      (possibleEffects, maximumEffects, exactEffects, name) => {
      const tool = descriptor(possibleEffects, maximumEffects, name);
      expect(descriptorAllowedForRepair(tool, "protected_completion")).toBe(true);
      const pureAction = possibleEffects.length === 1 && maximumEffects.length === 1
        && possibleEffects[0] === maximumEffects[0]
        ? possibleEffects[0] === "outcome.propose" ? "complete"
          : possibleEffects[0] === "outcome.request_input" ? "request_input" : null
        : null;
      expect(terminalProtocolAction(tool)).toBe(pureAction);
      expect(descriptorAllowedForRepair(tool, "evidence")).toBe(true);
      expect(descriptorAllowedForRepair(tool, "protected_recovery")).toBe(true);
      expect(effectsAllowedForRepair(exactEffects, "protected_completion")).toBe(true);
      expect(effectsAllowedForRepair(exactEffects, "evidence")).toBe(true);
      expect(effectsAllowedForRepair(exactEffects, "protected_recovery")).toBe(true);
    }));
  });

  it("always converges an explicit concrete question to a typed input proposal", () => {
    fc.assert(fc.property(nonBlankText, nonBlankText, (answer, question) => {
      let prepared = apply(initial(), "user.message", { text: answer });
      prepared = apply(prepared, "evidence.recorded", evidence());
      let attempted = settleModel(startModel(prepared, 1), {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "repair-input",
            name: "request_user_input",
            arguments: { message: question }
          }]
        },
        toolCalls: [{
          id: "repair-input",
          name: "request_user_input",
          arguments: { message: question }
        }],
        finishReason: "tool_calls"
      });
      expect(attempted).toMatchObject({
        phase: "tool_pending",
        pendingTools: [{ request: { callId: "repair-input", name: "request_user_input" } }]
      });
      const pending = attempted.pendingTools[0]!;
      attempted = apply(attempted, "tool.completed", {
        callId: "repair-input",
        ...pending.modelTurn,
        ok: true,
        output: JSON.stringify({ message: question.trim() }),
        observedEffects: ["outcome.request_input"],
        artifacts: [],
        diagnostics: [],
        startedAt: NOW,
        completedAt: NOW
      });
      expect(attempted.proposedOutcome).toEqual({
        kind: "needs_input",
        requestId: "repair-input",
        message: question.trim()
      });
      assertKernelInvariants(attempted);
    }));
  });

  it("always publishes ordinary text when its runtime completion intent succeeds", () => {
    fc.assert(fc.property(nonBlankText, nonBlankText, (answer, summary) => {
      let state = protectedAnswer(answer);
      const pending = state.pendingTools[0]!;
      state = apply(state, "tool.completed", {
        callId: pending.request.callId,
        ...pending.modelTurn,
        ok: true,
        output: JSON.stringify({ summary }),
        observedEffects: ["outcome.propose"],
        artifacts: [],
        diagnostics: [],
        startedAt: NOW,
        completedAt: NOW
      });
      expect(state.proposedOutcome).toMatchObject({ kind: "completed" });
      expect(state.proposedOutcome?.message).toContain(answer.trim());
      expect(state.proposedOutcome?.message).toContain(summary.trim());
      assertKernelInvariants(state);
    }));
  });

  it("accepts terminal receipts only from the two standard protocol tools", () => {
    let state = apply(initial(), "user.message", { text: "finish through the terminal protocol" });
    state = settleModel(startModel(state, 1), {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "custom-complete", name: "custom_terminal_alias", arguments: {} }]
      },
      toolCalls: [{ id: "custom-complete", name: "custom_terminal_alias", arguments: {} }],
      finishReason: "tool_calls"
    });
    const pending = state.pendingTools[0]!;
    state = apply(state, "tool.completed", {
      callId: "custom-complete",
      ...pending.modelTurn,
      ok: true,
      output: JSON.stringify({ summary: "alias completion" }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: NOW,
      completedAt: NOW
    });

    expect(state.proposedOutcome).toMatchObject({
      kind: "recoverable_failure",
      code: "terminal_protocol_invalid"
    });
    assertKernelInvariants(state);
  });

  it("rejects an input-effect receipt from a custom tool during protected recovery", () => {
    fc.assert(fc.property(nonBlankText, nonBlankText, (answer, question) => {
      const protectedState = protectedAnswer(answer);
      const modelTurn = { turnId: 2, effectRevision: protectedState.revision };
      const recoveryState: KernelState = {
        ...protectedState,
        phase: "tool_pending",
        completionRepairAttempts: 0,
        completionRepair: { kind: "protected_recovery", answer: answer.trim() },
        pendingTools: [{
          request: { callId: "custom-input", name: "custom_terminal_alias", arguments: {} },
          modelTurn,
          approval: "not_required",
          started: false
        }],
        toolCallIds: [...protectedState.toolCallIds, "custom-input"]
      };
      assertKernelInvariants(recoveryState);
      const attempted = apply(recoveryState, "tool.completed", {
        callId: "custom-input",
        ...modelTurn,
        ok: true,
        output: JSON.stringify({ message: question }),
        observedEffects: ["outcome.request_input"],
        artifacts: [],
        diagnostics: [],
        startedAt: NOW,
        completedAt: NOW
      });
      expect(attempted.proposedOutcome).toMatchObject({
        kind: "recoverable_failure",
        code: "terminal_protocol_invalid"
      });
      expect(attempted.proposedOutcome?.message).toContain(answer.trim());
      assertKernelInvariants(attempted);
    }));
  });
});
