import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue,
  type ToolEffect,
  type WorkspaceDelta
} from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  createKernelState,
  decide,
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
  calls: Array<{ id: string; name: string }>,
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
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: {} })),
    finishReason: "tool_calls"
  }, events);
}

interface SuccessfulReceiptOptions {
  observedEffects?: ToolEffect[];
  actualEffects?: ToolEffect[];
  workspaceDelta?: WorkspaceDelta;
}

function completePendingTool(
  state: KernelState,
  callId: string,
  options: SuccessfulReceiptOptions = {},
  events?: AgentEventEnvelope[]
): KernelState {
  const pending = state.pendingTools.find((item) => item.request.callId === callId)!;
  const observedEffects = options.observedEffects ?? ["filesystem.read"];
  return apply(state, "tool.completed", {
    callId,
    ...pending.modelTurn,
    ok: true,
    output: "completed",
    outcome: { status: "succeeded", output: "completed", diagnosticCodes: [] },
    observedEffects,
    ...(options.actualEffects === undefined ? {} : { actualEffects: options.actualEffects }),
    ...(options.workspaceDelta ? { workspaceDelta: options.workspaceDelta } : {}),
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: "start",
    completedAt: "end"
  }, events, "tool");
}

function successfulReceipt(
  state: KernelState,
  callId: string,
  toolName: string,
  options: SuccessfulReceiptOptions = {},
  events?: AgentEventEnvelope[]
): KernelState {
  return completePendingTool(queueTool(state, callId, toolName, events), callId, options, events);
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
        code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE,
        message: expect.stringContaining("successful process launch")
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

    state = failAlternative(state, "patch-attempt", "apply_patch", "workspace_transaction_cleanup_failed");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "workspace_transaction", attempts: 3 },
      proposedOutcome: {
        kind: "recoverable_failure",
        code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE
      }
    });
  });

  it("keeps checkpoint recovery failures in their own public family", () => {
    let state = failAlternative(initial(), "restore-one", "apply_patch", "checkpoint_recovery_failed");
    state = failAlternative(state, "restore-two", "edit", "recovery_retry_denied");
    state = failAlternative(state, "restore-three", "write", "recovery_result_lost_no_replay");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "checkpoint_recovery", attempts: 3 },
      proposedOutcome: { code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE }
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

  it("keeps an execution cluster across read/list work and informational evidence", () => {
    let state = failAlternative(initial(), "first", "exec", "process_spawn_failed");
    state = failAlternative(state, "second", "shell", "executable_not_found");
    state = successfulReceipt(state, "read-progress", "read_file", {
      observedEffects: ["filesystem.read"], actualEffects: ["filesystem.read"]
    });
    state = successfulReceipt(state, "list-progress", "list_files", {
      observedEffects: ["filesystem.read"], actualEffects: ["filesystem.read"]
    });
    const evidence: EvidenceRecord = {
      evidenceId: "real-progress",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "diagnostic",
      status: "informational",
      createdAt: "2026-07-12T00:00:00.000Z",
      producer: { authority: "runtime" },
      summary: "A capability was independently verified.",
      data: { source: "probe", diagnostic: { available: true } }
    };
    state = apply(state, "evidence.recorded", evidence);
    expect(state.semanticFailureCluster).toMatchObject({ family: "execution_capability", attempts: 2 });
    expect(state.semanticProgress.durableEvidence).toBe(1);
    expect(state.semanticFailureCluster?.progress).toEqual(state.semanticProgress);

    state = failAlternative(state, "third", "validate", "shell_unavailable");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "execution_capability", attempts: 3 },
      proposedOutcome: { code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE }
    });

    state = apply(state, "evidence.recorded", {
      ...evidence,
      evidenceId: "post-threshold-information",
      summary: "A read-only inventory completed after the execution failures."
    });
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { attempts: 3 },
      proposedOutcome: { code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE }
    });
    expect(decide(state)).toEqual([expect.objectContaining({
      type: "finish_run",
      outcome: expect.objectContaining({ code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE })
    })]);
  });

  it("only treats a verified launch-tool receipt as execution recovery", () => {
    let state = failAlternative(initial(), "first", "exec", "process_spawn_failed");
    state = failAlternative(state, "second", "shell", "executable_not_found");
    for (const toolName of ["process_poll", "process_write", "process_terminate"]) {
      state = successfulReceipt(state, `successful-${toolName}`, toolName, {
        observedEffects: ["process.spawn.readonly"], actualEffects: ["process.spawn.readonly"]
      });
      expect(state.semanticFailureCluster?.attempts).toBe(2);
    }

    state = successfulReceipt(state, "real-launch", "exec", {
      observedEffects: ["process.spawn.readonly"], actualEffects: ["process.spawn.readonly"]
    });
    expect(state.semanticFailureCluster).toBeUndefined();
    state = failAlternative(state, "after-recovery", "exec", "process_spawn_failed");
    expect(state.semanticFailureCluster?.attempts).toBe(1);

    state = successfulReceipt(state, "legacy-launch", "shell", {
      observedEffects: ["process.spawn.readonly"]
    });
    expect(state.semanticFailureCluster).toBeUndefined();
  });

  it("does not fall back to observed effects when actualEffects is explicitly empty", () => {
    let state = failAlternative(initial(), "first", "exec", "process_spawn_failed");
    state = failAlternative(state, "second", "shell", "executable_not_found");
    state = successfulReceipt(state, "empty-actual-launch", "exec", {
      observedEffects: ["process.spawn.readonly"], actualEffects: []
    });
    expect(state.semanticFailureCluster?.attempts).toBe(2);
    state = failAlternative(state, "third", "validate", "shell_unavailable");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { attempts: 3 },
      proposedOutcome: { code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE }
    });
  });

  it("preserves the reached execution cluster through a fourth receipt and failed workspace delta", () => {
    const events: AgentEventEnvelope[] = [];
    let state = queueTools(initial(), [
      { id: "first", name: "exec" },
      { id: "second", name: "shell" },
      { id: "third", name: "validate" },
      { id: "fourth", name: "exec" }
    ], events);
    state = failedReceipt(state, "first", "process_spawn_failed", events);
    state = failedReceipt(state, "second", "executable_not_found", events);
    state = failedReceipt(state, "third", "shell_unavailable", events, {
      added: [], modified: ["src/transient-third.ts"], deleted: []
    });
    expect(state).toMatchObject({
      phase: "tool_pending",
      semanticProgress: { workspaceChanges: 1 },
      semanticFailureCluster: { family: "execution_capability", attempts: 3 }
    });

    state = failedReceipt(state, "fourth", "process_spawn_failed", events, {
      added: [], modified: ["src/transient-fourth.ts"], deleted: []
    });
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticProgress: { workspaceChanges: 2 },
      semanticFailureCluster: { family: "execution_capability", attempts: 3 },
      proposedOutcome: { code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE }
    });
    expect(state.semanticFailureCluster?.progress).toEqual(state.semanticProgress);

    const replayed = rehydrate(initial(), events);
    assertKernelInvariants(replayed);
    expect(replayed).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "execution_capability", attempts: 3 }
    });
    expect(decide(replayed)).toEqual(decide(state));
  });

  it("allows an already-started successful launch to recover a threshold cluster", () => {
    let state = queueTools(initial(), [
      { id: "first", name: "exec" },
      { id: "second", name: "shell" },
      { id: "third", name: "validate" },
      { id: "recovery", name: "process_spawn" }
    ]);
    state = failedReceipt(state, "first", "process_spawn_failed");
    state = failedReceipt(state, "second", "executable_not_found");
    state = failedReceipt(state, "third", "shell_unavailable");
    expect(state.semanticFailureCluster?.attempts).toBe(3);
    state = completePendingTool(state, "recovery", {
      observedEffects: ["process.spawn.readonly"], actualEffects: ["process.spawn.readonly"]
    });
    expect(state).toMatchObject({ phase: "ready_model" });
    expect(state.semanticFailureCluster).toBeUndefined();
    expect(state.proposedOutcome).toBeUndefined();
  });

  it("retains legacy reset behavior for non-execution infrastructure clusters", () => {
    let state = failAlternative(initial(), "first", "edit", "workspace_transaction_root_unavailable");
    state = failAlternative(state, "second", "write", "workspace_transaction_cleanup_failed");
    state = failAlternative(state, "third", "apply_patch", "workspace_transaction_root_unavailable");
    expect(state).toMatchObject({
      phase: "outcome_pending",
      semanticFailureCluster: { family: "workspace_transaction", attempts: 3 }
    });
    const evidence: EvidenceRecord = {
      evidenceId: "non-execution-progress",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "diagnostic",
      status: "passed",
      createdAt: "2026-07-12T00:00:00.000Z",
      producer: { authority: "runtime" },
      summary: "The workspace transaction service recovered.",
      data: { source: "transaction-probe", diagnostic: { available: true } }
    };
    state = apply(state, "evidence.recorded", evidence);
    expect(state).toMatchObject({ phase: "ready_model" });
    expect(state.semanticFailureCluster).toBeUndefined();
    expect(state.proposedOutcome).toBeUndefined();

    state = failAlternative(state, "after-evidence", "edit", "workspace_transaction_root_unavailable");
    state = successfulReceipt(state, "workspace-progress", "write_file", {
      observedEffects: ["filesystem.write"],
      actualEffects: ["filesystem.write"],
      workspaceDelta: { added: [], modified: ["src/recovered.ts"], deleted: [] }
    });
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
