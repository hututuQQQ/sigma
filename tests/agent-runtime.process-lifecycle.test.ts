import { describe, expect, it, vi } from "vitest";
import type {
  AgentEventType,
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import { completionFailure } from "../packages/agent-runtime/src/effect-helpers.js";
import { terminateRunProcesses } from "../packages/agent-runtime/src/process-cleanup.js";
import { finishRuntimeSession } from "../packages/agent-runtime/src/runtime-session-finish.js";
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
    const failure = completionFailure(
      runtimeSessionFixture({ state }),
      call("complete_task"),
      { possibleEffects: ["outcome.propose"] } as ToolDescriptor,
      "2026-01-01T00:00:00.000Z"
    );
    expect(failure).toMatchObject({ ok: false, diagnostics: ["active_processes"] });
    expect(failure?.output).toContain("process-active");
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
    const failure = completionFailure(
      target,
      call("complete_task"),
      { possibleEffects: ["outcome.propose"] } as ToolDescriptor,
      "2026-01-01T00:00:00.000Z"
    );

    expect(failure).toMatchObject({
      diagnostics: ["active_processes"],
      result: {
        deliverableProcessIds: ["service"],
        sessionProcessIds: ["helper"],
        nextActions: [
          { tool: "process_handoff", processIds: ["service"] },
          { tool: "process_terminate", processIds: ["helper"] }
        ]
      }
    });
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
