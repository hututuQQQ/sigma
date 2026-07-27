import { describe, expect, it, vi } from "vitest";
import type {
  AgentEventType,
  ModelToolCall,
  ToolCallPlan,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import { completionGateDecision } from "../packages/agent-runtime/src/completion-evidence-gate.js";
import { terminateRunProcesses } from "../packages/agent-runtime/src/process-cleanup.js";
import {
  settleBudgetBoundaryProcesses,
  terminateUnhandedBudgetBoundaryProcesses
} from "../packages/agent-runtime/src/process-budget-settlement.js";
import { finishRuntimeSession } from "../packages/agent-runtime/src/runtime-session-finish.js";
import { finishSolvingBudgetBoundary } from "../packages/agent-runtime/src/solving-budget-boundary.js";
import type { ProcessExecutionPort } from "../packages/agent-platform/src/index.js";
import {
  recordLostProcess,
  recordProcessReceipt
} from "../packages/agent-runtime/src/process-lifecycle.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const session = runtimeSessionFixture();

function call(name: string, argumentsValue: ModelToolCall["arguments"] = {}): ModelToolCall {
  return { id: `call-${name}`, name, arguments: argumentsValue };
}

function receipt(output: unknown): ToolReceipt {
  return {
    callId: "call",
    ok: true,
    output: typeof output === "string" ? output : JSON.stringify(output),
    observedEffects: ["process.spawn.readonly"],
    actualEffects: ["process.spawn.readonly"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z"
  };
}

function plan(processMode: ToolCallPlan["processMode"]): ToolCallPlan {
  return {
    exactEffects: ["process.spawn.readonly"],
    readPaths: ["."],
    writePaths: [],
    network: "none",
    processMode,
    checkpointScope: [],
    idempotence: "non_replayable"
  };
}

function recorder(): {
  events: Array<{ type: AgentEventType; payload: unknown }>;
  emit: Parameters<typeof recordProcessReceipt>[4];
} {
  const events: Array<{ type: AgentEventType; payload: unknown }> = [];
  return {
    events,
    emit: async (_session, type, _authority, payload) => {
      events.push({ type, payload });
      return {} as Awaited<ReturnType<Parameters<typeof recordProcessReceipt>[4]>>;
    }
  };
}

describe("durable process lifecycle events", () => {
  it("settles progressing session processes at a solver-budget boundary without terminating them", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([[
          "process-build",
          { id: "process-build", brokerInstanceId: "broker-1", lifecycle: "session" }
        ]])
      }
    });
    target.durable.state.activeProcessIds.push("process-build");
    const recorded = recorder();
    const terminate = vi.fn();
    const releaseOutputArtifacts = vi.fn(async () => undefined);
    const createArtifact = vi.fn(async () => "settled-output-artifact");
    const brokerArtifact = {
      brokerArtifactId: "broker-output-1",
      name: "stdout.txt",
      stream: "stdout" as const,
      brokerSha256: "a".repeat(64),
      sizeBytes: 5,
      complete: true,
      redactionLossy: false,
      mediaType: "text/plain; charset=utf-8" as const,
      content: Buffer.from("full\n", "utf8")
    };
    let polls = 0;
    const execution = {
      execute: async () => { throw new Error("not used"); },
      poll: async (handle) => {
        polls += 1;
        return polls === 1
          ? {
              handle,
              state: "running" as const,
              exitCode: null,
              signal: null,
              durationMs: 10,
              stdout: "building\n",
              stderr: "",
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0,
              outputTruncated: false,
              outputArtifacts: [brokerArtifact]
            }
          : {
              handle,
              state: "exited" as const,
              exitCode: 0,
              signal: null,
              durationMs: 20,
              stdout: "done\n",
              stderr: "",
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0,
              outputTruncated: false,
              outputArtifacts: [brokerArtifact]
            };
      },
      terminate,
      releaseOutputArtifacts
    } satisfies ProcessExecutionPort;

    await expect(settleBudgetBoundaryProcesses(
      target,
      new AbortController().signal,
      {
        execution,
        emit: recorded.emit,
        createArtifact
      }
    )).resolves.toEqual({ attempted: 1, settled: 1, unavailable: false });

    expect(polls).toBe(2);
    expect(terminate).not.toHaveBeenCalled();
    expect(createArtifact).toHaveBeenCalledTimes(1);
    expect(releaseOutputArtifacts).toHaveBeenCalledTimes(1);
    expect(releaseOutputArtifacts).toHaveBeenCalledWith(["broker-output-1"]);
    expect(target.execution.processHandles.size).toBe(0);
    expect(recorded.events).toEqual(expect.arrayContaining([
      {
        type: "process.output",
        payload: { processId: "process-build", stream: "stdout", chunk: "building\n" }
      },
      {
        type: "process.output",
        payload: { processId: "process-build", stream: "stdout", chunk: "done\n" }
      },
      {
        type: "process.exited",
        payload: {
          processId: "process-build",
          exitCode: 0,
          state: "exited",
          reason: "budget_boundary_settlement"
        }
      }
    ]));
    expect(recorded.events).toContainEqual({
      type: "evidence.recorded",
      payload: expect.objectContaining({
        kind: "diagnostic",
        status: "passed",
        data: expect.objectContaining({
          source: "background_process_settlement",
          diagnostic: expect.objectContaining({
            outputArtifactIds: ["settled-output-artifact"]
          })
        })
      })
    });
  });

  it("records a failed lifecycle evidence item when polling loses a process", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([[
          "process-lost",
          { id: "process-lost", brokerInstanceId: "broker-1", lifecycle: "session" }
        ]])
      }
    });
    target.durable.state.activeProcessIds.push("process-lost");
    const recorded = recorder();
    const execution = {
      execute: async () => { throw new Error("not used"); },
      poll: async () => { throw new Error("broker disconnected"); }
    } satisfies ProcessExecutionPort;

    await expect(settleBudgetBoundaryProcesses(
      target,
      new AbortController().signal,
      {
        execution,
        emit: recorded.emit,
        createArtifact: async () => "unused"
      }
    )).resolves.toEqual({ attempted: 1, settled: 1, unavailable: false });

    expect(recorded.events).toContainEqual({
      type: "evidence.recorded",
      payload: expect.objectContaining({
        kind: "diagnostic",
        status: "failed",
        data: expect.objectContaining({
          source: "background_process_settlement",
          diagnostic: expect.objectContaining({
            state: "lost",
            failure: {
              code: "process_poll_failed",
              message: "broker disconnected"
            }
          })
        })
      })
    });
  });

  it("does not wait on a deliverable process that requires an explicit handoff", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([[
          "service",
          { id: "service", brokerInstanceId: "broker-1", lifecycle: "deliverable" }
        ]])
      }
    });
    const poll = vi.fn();
    const execution = {
      execute: async () => { throw new Error("not used"); },
      poll
    } satisfies ProcessExecutionPort;
    await expect(settleBudgetBoundaryProcesses(
      target,
      new AbortController().signal,
      {
        execution,
        emit: recorder().emit,
        createArtifact: async () => "unused"
      }
    )).resolves.toEqual({ attempted: 0, settled: 0, unavailable: false });
    expect(poll).not.toHaveBeenCalled();
    expect(target.execution.processHandles.has("service")).toBe(true);
  });

  it("terminates an unhanded deliverable before resource-boundary completion", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([[
          "service",
          { id: "service", brokerInstanceId: "broker-1", lifecycle: "deliverable" }
        ]])
      }
    });
    target.durable.state.activeProcessIds.push("service");
    target.durable.state.deadlineRemainingMs = 60_000;
    target.durable.state.messages.push({
      role: "assistant",
      content: "Current workspace state is ready for external evaluation."
    });
    const events: Array<{ type: AgentEventType; payload: unknown }> = [];
    const emit = vi.fn(async (
      current: typeof target,
      type: AgentEventType,
      _authority: string,
      payload: unknown
    ) => {
      events.push({ type, payload });
      if (type === "process.exited" || type === "process.lost") {
        const processId = (payload as { processId?: unknown }).processId;
        current.durable.state.activeProcessIds =
          current.durable.state.activeProcessIds.filter((id) => id !== processId);
      }
      return {} as never;
    });
    const terminate = vi.fn(async (handle) => ({
      handle,
      state: "terminated" as const,
      exitCode: null,
      signal: "SIGTERM",
      durationMs: 1,
      stdout: "",
      stderr: "",
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
      outputTruncated: false
    }));
    const finish = vi.fn(async () => true);

    await expect(finishSolvingBudgetBoundary(
      target,
      new AbortController().signal,
      {
        kind: "recoverable_failure",
        code: "budget_exhausted",
        message: "No model-turn budget remains.",
        decisionAuthority: "resource_boundary"
      },
      {
        reviews: {} as never,
        longHorizon: {} as never,
        emit: emit as never,
        finish,
        runtime: {
          execution: {
            execute: async () => { throw new Error("not used"); },
            terminate
          }
        } as never,
        createArtifact: async () => "unused"
      }
    )).resolves.toBe(true);

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(target.execution.processHandles.size).toBe(0);
    expect(target.durable.state.activeProcessIds).toEqual([]);
    expect(events).toContainEqual({
      type: "process.exited",
      payload: expect.objectContaining({
        processId: "service",
        reason: "budget_boundary_unhanded_deliverable"
      })
    });
    expect(finish).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        kind: "completed",
        decisionAuthority: "resource_boundary"
      }),
      target.durable.state.revision
    );
  });

  it("terminates only deliverable processes in the boundary cleanup", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([
          ["service", { id: "service", brokerInstanceId: "broker-1", lifecycle: "deliverable" }],
          ["helper", { id: "helper", brokerInstanceId: "broker-1", lifecycle: "session" }]
        ])
      }
    });
    const recorded = recorder();
    const terminate = vi.fn(async (handle) => ({
      handle,
      state: "terminated" as const,
      exitCode: null,
      signal: "SIGTERM",
      durationMs: 1,
      stdout: "",
      stderr: "",
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
      outputTruncated: false
    }));

    await expect(terminateUnhandedBudgetBoundaryProcesses(
      target,
      new AbortController().signal,
      {
        execution: {
          execute: async () => { throw new Error("not used"); },
          terminate
        },
        emit: recorded.emit,
        createArtifact: async () => "unused"
      }
    )).resolves.toEqual({ attempted: 1, settled: 1, unavailable: false });

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate.mock.calls[0]?.[0]).toMatchObject({ id: "service" });
    expect(target.execution.processHandles.has("service")).toBe(false);
    expect(target.execution.processHandles.has("helper")).toBe(true);
  });

  it("records background and PTY process handles", async () => {
    const recorded = recorder();
    await recordProcessReceipt(
      session,
      call("process_spawn", { pty: true }),
      plan("pty"),
      receipt({ id: "process-1", brokerInstanceId: "broker-1" }),
      recorded.emit
    );
    expect(recorded.events).toEqual([{
      type: "process.spawned",
      payload: {
        processId: "process-1",
        executionId: "call-process_spawn",
        mode: "pty",
        lifecycle: "session",
        brokerInstanceId: "broker-1"
      }
    }]);
  });

  it("tracks disposable-environment processes under the same lifecycle", async () => {
    const target = runtimeSessionFixture();
    const recorded = recorder();
    await recordProcessReceipt(
      target,
      call("environment_process_spawn", { lifecycle: "deliverable" }),
      plan("background"),
      receipt({
        id: "environment-service",
        brokerInstanceId: "broker-1",
        lifecycle: "deliverable"
      }),
      recorded.emit
    );
    expect(target.execution.processHandles.get("environment-service")).toMatchObject({
      lifecycle: "deliverable",
      brokerInstanceId: "broker-1"
    });
    expect(recorded.events).toEqual([{
      type: "process.spawned",
      payload: {
        processId: "environment-service",
        executionId: "call-environment_process_spawn",
        mode: "background",
        lifecycle: "deliverable",
        brokerInstanceId: "broker-1"
      }
    }]);
  });

  it("records unified shell background startup and immediate terminal state", async () => {
    const target = runtimeSessionFixture();
    const recorded = recorder();
    await recordProcessReceipt(
      target,
      call("shell", { background: true }),
      plan("background"),
      receipt({
        handle: {
          id: "unified-process",
          brokerInstanceId: "broker-1",
          lifecycle: "session"
        },
        state: "exited",
        exitCode: 0,
        signal: null,
        stdout: "ready\n",
        stderr: ""
      }),
      recorded.emit
    );
    expect(target.execution.processHandles.has("unified-process")).toBe(false);
    expect(recorded.events).toEqual([
      {
        type: "process.spawned",
        payload: {
          processId: "unified-process",
          executionId: "call-shell",
          mode: "background",
          lifecycle: "session",
          brokerInstanceId: "broker-1"
        }
      },
      {
        type: "process.output",
        payload: {
          processId: "unified-process",
          stream: "stdout",
          chunk: "ready\n"
        }
      },
      {
        type: "process.exited",
        payload: {
          processId: "unified-process",
          exitCode: 0,
          state: "exited"
        }
      }
    ]);
  });

  it("records incremental output and terminal state", async () => {
    const recorded = recorder();
    await recordProcessReceipt(
      session,
      call("process_poll"),
      plan("background"),
      receipt({
        handle: { id: "process-2", brokerInstanceId: "broker-1" },
        state: "exited",
        exitCode: 0,
        signal: null,
        stdout: "ready\n",
        stderr: "warning\n"
      }),
      recorded.emit
    );
    expect(recorded.events).toEqual([
      { type: "process.output", payload: { processId: "process-2", stream: "stdout", chunk: "ready\n" } },
      { type: "process.output", payload: { processId: "process-2", stream: "stderr", chunk: "warning\n" } },
      { type: "process.exited", payload: { processId: "process-2", exitCode: 0, state: "exited" } }
    ]);
  });

  it("records deliverable handoff and removes it from runtime ownership", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([[
          "process-deliverable",
          { id: "process-deliverable", brokerInstanceId: "broker-1", lifecycle: "deliverable" }
        ]])
      }
    });
    const recorded = recorder();
    await recordProcessReceipt(
      target,
      call("process_handoff", { handleId: "process-deliverable", brokerInstanceId: "broker-1" }),
      { ...plan("background"), exactEffects: ["process.handoff"] },
      receipt({
        handle: { id: "process-deliverable", brokerInstanceId: "broker-1", lifecycle: "deliverable" },
        handoffId: "handoff:process-deliverable",
        systemProcessId: 4321
      }),
      recorded.emit
    );

    expect(target.execution.processHandles.has("process-deliverable")).toBe(false);
    expect(recorded.events).toEqual([{
      type: "process.handed_off",
      payload: {
        processId: "process-deliverable",
        handoffId: "handoff:process-deliverable",
        systemProcessId: 4321
      }
    }]);
  });

  it("records a broker-lost handle and ignores process writes", async () => {
    const recorded = recorder();
    await recordProcessReceipt(
      session,
      call("process_write"),
      plan("background"),
      receipt({ written: true }),
      recorded.emit
    );
    await recordLostProcess(
      session,
      call("process_poll", { handleId: "process-3", brokerInstanceId: "broker-1" }),
      Object.assign(new Error("broker ended"), { code: "process_lost", data: { handleId: "process-3" } }),
      recorded.emit
    );
    expect(recorded.events).toEqual([{
      type: "process.lost",
      payload: { processId: "process-3", reason: "broker ended" }
    }]);
  });

  it("fails closed on malformed process receipts", async () => {
    await expect(recordProcessReceipt(
      session,
      call("process_spawn"),
      plan("background"),
      receipt("not-json"),
      recorder().emit
    )).rejects.toMatchObject({ code: "tool_protocol_error" });
  });

  it("blocks task completion until all background processes settle", () => {
    const state = createKernelState({
      sessionId: "session",
      runId: "run",
      mode: "change",
      startedAt: "2026-01-01T00:00:00.000Z",
      deadlineAt: "2026-01-01T01:00:00.000Z"
    });
    state.activeProcessIds.push("process-active");
    const decision = completionGateDecision(runtimeSessionFixture({ state }));
    expect(decision).toMatchObject({ action: "continue" });
    if (decision.action !== "continue") throw new Error("Expected a completion advisory.");
    expect(decision.message).toContain("process-active");
  });

  it("directs deliverable processes to handoff and session processes to termination", () => {
    const state = createKernelState({
      sessionId: "session", runId: "run", mode: "change",
      startedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-01-01T01:00:00.000Z"
    });
    state.activeProcessIds.push("service", "helper");
    const target = runtimeSessionFixture({
      state,
      execution: {
        processHandles: new Map([
          ["service", { id: "service", brokerInstanceId: "broker-1", lifecycle: "deliverable" }],
          ["helper", { id: "helper", brokerInstanceId: "broker-1", lifecycle: "session" }]
        ])
      }
    });
    const decision = completionGateDecision(target);
    expect(decision).toMatchObject({ action: "continue" });
    if (decision.action !== "continue") throw new Error("Expected a completion advisory.");
    expect(decision.message).toContain("service");
    expect(decision.message).toContain("helper");
  });

  it("terminates runtime-local process trees before a terminal outcome", async () => {
    const target = runtimeSessionFixture({
      execution: {
        processHandles: new Map([["process-4", { id: "process-4", brokerInstanceId: "broker-1" }]])
      }
    });
    const recorded = recorder();
    const execution = {
      execute: async () => { throw new Error("not used"); },
      terminate: async (handle) => ({
        handle,
        state: "terminated" as const,
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 1,
        stdout: "stopped\n",
        stderr: "",
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0,
        outputTruncated: false
      })
    } satisfies ProcessExecutionPort;
    await terminateRunProcesses(target, { kind: "cancelled", reason: "user" }, execution, recorded.emit);
    expect(target.execution.processHandles.size).toBe(0);
    expect(recorded.events).toEqual([
      { type: "process.output", payload: { processId: "process-4", stream: "stdout", chunk: "stopped\n" } },
      {
        type: "process.exited",
        payload: {
          processId: "process-4",
          exitCode: null,
          signal: "SIGTERM",
          state: "terminated",
          reason: "run_cancelled"
        }
      }
    ]);
  });

  it("does not terminate processes for a stale outcome revision", async () => {
    const state = createKernelState({
      sessionId: "stale-session",
      runId: "stale-run",
      mode: "change",
      startedAt: "2026-01-01T00:00:00.000Z",
      deadlineAt: "2026-01-01T01:00:00.000Z"
    });
    state.phase = "outcome_pending";
    state.revision = 7;
    const beforeOutcome = vi.fn(async () => 0);
    const target = runtimeSessionFixture({
      state,
      execution: {
        processHandles: new Map([["still-running", { id: "still-running", brokerInstanceId: "broker-1" }]])
      }
    });
    await expect(finishRuntimeSession({
      beforeOutcome
    } as unknown as Parameters<typeof finishRuntimeSession>[0], target, {
      kind: "completed", message: "stale", evidence: []
    }, 6)).resolves.toBe(false);
    expect(beforeOutcome).not.toHaveBeenCalled();
    expect(target.execution.processHandles.has("still-running")).toBe(true);
  });
});
