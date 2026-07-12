import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  createKernelState,
  evolve,
  rehydrate,
  SEMANTIC_INFRASTRUCTURE_FAILURE_CODE,
  type KernelState
} from "../packages/agent-kernel/src/index.js";
import { toolReceipt } from "../packages/agent-kernel/src/receipt-parsing.js";

function initial(): KernelState {
  return createKernelState({
    sessionId: "semantic-session",
    runId: "semantic-run",
    mode: "change",
    startedAt: "2026-07-12T00:00:00.000Z",
    deadlineAt: "2026-07-12T00:15:00.000Z"
  });
}

function envelope(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue,
  authority: AgentEventEnvelope["authority"] = "runtime"
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: state.lastSeq + 1,
    eventId: `semantic-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: "2026-07-12T00:00:00.000Z",
    type,
    authority,
    payload
  };
}

function apply(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue,
  events?: AgentEventEnvelope[],
  authority?: AgentEventEnvelope["authority"]
): KernelState {
  const event = envelope(state, type, payload, authority);
  events?.push(event);
  return evolve(state, event);
}

function queueTool(
  state: KernelState,
  callId: string,
  name: string,
  events?: AgentEventEnvelope[]
): KernelState {
  let next = state;
  if (next.phase === "idle") next = apply(next, "user.message", { text: "diagnose" }, events, "user");
  const turnId = next.toolCallIds.length + 1;
  next = apply(next, "model.started", { turnId, effectRevision: next.revision }, events);
  const turn = next.activeModelTurn!;
  return apply(next, "model.completed", {
    ...turn,
    message: { role: "assistant", content: "" },
    toolCalls: [{ id: callId, name, arguments: { alternative: callId } }],
    finishReason: "tool_calls"
  }, events);
}

function queueTools(
  state: KernelState,
  calls: Array<{ id: string; name: string }>
): KernelState {
  let next = state;
  if (next.phase === "idle") next = apply(next, "user.message", { text: "diagnose" }, undefined, "user");
  const turnId = next.toolCallIds.length + 1;
  next = apply(next, "model.started", { turnId, effectRevision: next.revision });
  const turn = next.activeModelTurn!;
  return apply(next, "model.completed", {
    ...turn,
    message: { role: "assistant", content: "" },
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: {} })),
    finishReason: "tool_calls"
  });
}

function failedReceipt(
  state: KernelState,
  callId: string,
  diagnosticCode: string,
  events?: AgentEventEnvelope[],
  workspaceDelta?: { added: string[]; modified: string[]; deleted: string[] }
): KernelState {
  const pending = state.pendingTools.find((item) => item.request.callId === callId)!;
  return apply(state, "tool.failed", {
    callId,
    ...pending.modelTurn,
    ok: false,
    output: "execution failed",
    outcome: { status: "failed", output: "execution failed", diagnosticCodes: [diagnosticCode] },
    observedEffects: ["process.spawn.readonly"],
    ...(workspaceDelta ? { workspaceDelta } : {}),
    artifacts: [],
    diagnostics: [diagnosticCode],
    evidence: [],
    startedAt: "start",
    completedAt: "end"
  }, events, "tool");
}

function failAlternative(
  state: KernelState,
  callId: string,
  toolName: string,
  diagnosticCode: string,
  events?: AgentEventEnvelope[]
): KernelState {
  return failedReceipt(queueTool(state, callId, toolName, events), callId, diagnosticCode, events);
}

describe("semantic execution failure convergence", () => {
  it("puts structured outcome, diagnostics, and evidence summaries in modern tool history", () => {
    const evidence: EvidenceRecord = {
      evidenceId: "diagnostic-proof",
      sessionId: "semantic-session",
      runId: "semantic-run",
      kind: "diagnostic",
      status: "failed",
      createdAt: "2026-07-12T00:00:00.000Z",
      producer: { authority: "tool", id: "modern" },
      summary: "Executable capability probe failed.",
      data: { source: "sigma-exec", diagnostic: { code: "executable_not_found" } }
    };
    let state = queueTool(initial(), "modern", "exec");
    const pending = state.pendingTools[0]!;
    state = apply(state, "tool.failed", {
      callId: "modern",
      ...pending.modelTurn,
      ok: false,
      output: "node was unavailable",
      outcome: { status: "failed", output: "node was unavailable", diagnosticCodes: ["executable_not_found"] },
      observedEffects: ["process.spawn.readonly"],
      artifacts: [],
      diagnostics: ["executable_not_found"],
      evidence: [evidence],
      startedAt: "start",
      completedAt: "end"
    }, undefined, "tool");

    const content = state.messages.at(-1)?.content ?? "";
    expect(content).toContain("Failed tool receipt ID: modern");
    expect(content).toContain("Receipt summary (JSON):");
    expect(content).toContain('"diagnosticCodes":["executable_not_found"]');
    expect(content).toContain('"evidenceId":"diagnostic-proof"');
    expect(content).toContain("Output:\nnode was unavailable");
    expect(state.receipts[0]).toMatchObject({
      outcome: { status: "failed", diagnosticCodes: ["executable_not_found"] }
    });
  });

  it("clusters equivalent infrastructure diagnostics across different tools and stops after three attempts", () => {
    let state = failAlternative(initial(), "powershell-attempt", "shell", "process_spawn_failed");
    state = failAlternative(state, "node-attempt", "exec", "executable_not_found");
    expect(state).toMatchObject({
      phase: "ready_model",
      semanticFailureCluster: { family: "execution_capability", attempts: 2 }
    });

    state = failAlternative(state, "cmd-attempt", "shell", "shell_unavailable");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "execution_capability", attempts: 3 },
      proposedOutcome: {
        kind: "recoverable_failure",
        code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE
      }
    });
  });

  it("converges repeated workspace transaction infrastructure failures across mutation tools", () => {
    let state = failAlternative(initial(), "edit-attempt", "edit", "workspace_transaction_root_unavailable");
    state = failAlternative(state, "write-attempt", "write", "workspace_transaction_root_unavailable");
    expect(state).toMatchObject({
      phase: "ready_model",
      semanticFailureCluster: { family: "workspace_transaction", attempts: 2 }
    });

    state = failAlternative(state, "patch-attempt", "apply_patch", "checkpoint_recovery_failed");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "workspace_transaction", attempts: 3 },
      proposedOutcome: {
        kind: "recoverable_failure",
        code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE
      }
    });
  });

  it("latches a reached cluster across another failure family and same-call evidence", () => {
    let state = queueTools(initial(), [
      { id: "infra-one", name: "shell" },
      { id: "infra-two", name: "exec" },
      { id: "infra-three", name: "shell" },
      { id: "other-family-last", name: "validate" }
    ]);
    state = failedReceipt(state, "infra-one", "process_spawn_failed");
    state = failedReceipt(state, "infra-two", "executable_not_found");
    state = failedReceipt(state, "infra-three", "shell_unavailable");
    expect(state.phase).toBe("tool_pending");
    state = failedReceipt(state, "other-family-last", "broker_timeout");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "execution_capability", attempts: 3 },
      proposedOutcome: { code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE }
    });

    const evidence: EvidenceRecord = {
      evidenceId: "failed-call-warning",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "diagnostic",
      status: "warning",
      createdAt: "2026-07-12T00:00:00.000Z",
      producer: { authority: "tool", id: "infra-three" },
      summary: "The failed call emitted a warning.",
      data: { source: "fixture", diagnostic: { retryable: true } }
    };
    state = apply(state, "evidence.recorded", evidence, undefined, "tool");
    expect(state.phase).toBe("outcome_pending");
    expect(state.semanticFailureCluster?.attempts).toBe(3);
  });

  it("never treats ordinary non-zero command or validation exits as infrastructure failure clusters", () => {
    let state = initial();
    for (const callId of ["test-one", "test-two", "test-three", "test-four"]) {
      state = failAlternative(state, callId, "validate", "exit_code=1");
    }
    expect(state.phase).toBe("ready_model");
    expect(state.semanticFailureCluster).toBeUndefined();
    expect(state.proposedOutcome).toBeUndefined();

    for (const callId of ["policy-one", "policy-two", "policy-three"]) {
      state = failAlternative(state, callId, "exec", "policy_denied");
    }
    expect(state.semanticFailureCluster).toBeUndefined();
  });

  it("preserves an explicit empty actual-effects projection during durable parsing", () => {
    expect(toolReceipt({
      callId: "empty-effects",
      ok: false,
      output: "denied",
      observedEffects: ["process.spawn.readonly"],
      actualEffects: [],
      artifacts: [],
      diagnostics: ["policy_denied"],
      startedAt: "start",
      completedAt: "end"
    })).toMatchObject({ actualEffects: [] });
  });

  it("resets a failure cluster on durable evidence progress, workspace progress, and steer", () => {
    let state = failAlternative(initial(), "first", "exec", "process_spawn_failed");
    state = failAlternative(state, "second", "shell", "executable_not_found");
    const evidence: EvidenceRecord = {
      evidenceId: "real-progress",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "diagnostic",
      status: "passed",
      createdAt: "2026-07-12T00:00:00.000Z",
      producer: { authority: "runtime" },
      summary: "A capability was independently verified.",
      data: { source: "probe", diagnostic: { available: true } }
    };
    state = apply(state, "evidence.recorded", evidence);
    expect(state.semanticFailureCluster).toBeUndefined();
    expect(state.semanticProgress.durableEvidence).toBe(1);

    state = failAlternative(state, "after-evidence", "exec", "process_spawn_failed");
    expect(state.semanticFailureCluster?.attempts).toBe(1);
    state = failedReceipt(
      queueTool(state, "workspace-progress", "shell"),
      "workspace-progress",
      "shell_unavailable",
      undefined,
      { added: [], modified: ["src/recovered.ts"], deleted: [] }
    );
    expect(state.semanticFailureCluster).toBeUndefined();
    expect(state.semanticProgress.workspaceChanges).toBe(1);

    state = failAlternative(state, "before-steer", "exec", "process_spawn_failed");
    state = apply(state, "user.steer", { text: "use the verified route" }, undefined, "user");
    expect(state.semanticFailureCluster).toBeUndefined();
  });

  it("replays the same semantic cluster and progress watermark from durable events", () => {
    const events: AgentEventEnvelope[] = [];
    let state = failAlternative(initial(), "first-replay", "shell", "process_spawn_failed", events);
    state = failAlternative(state, "second-replay", "exec", "executable_not_found", events);
    const replayed = rehydrate(initial(), events);
    expect(replayed.semanticFailureCluster).toEqual(state.semanticFailureCluster);
    expect(replayed.semanticProgress).toEqual(state.semanticProgress);
  });
});
