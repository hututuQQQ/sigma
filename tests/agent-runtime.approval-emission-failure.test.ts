import type { ToolCallPlan, ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import { requestDelegatedApproval } from "../packages/agent-runtime/src/delegated-approval.js";
import { ToolApprovalCoordinator } from "../packages/agent-runtime/src/tool-approval-coordinator.js";
import type { ApprovalWaiter, RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";
import { describe, expect, it } from "vitest";

const call = {
  id: "approval-call",
  name: "write",
  arguments: { path: "result.txt", content: "value" }
};

const plan: ToolCallPlan = {
  exactEffects: ["filesystem.write"],
  readPaths: ["result.txt"],
  writePaths: ["result.txt"],
  network: "none",
  processMode: "none",
  checkpointScope: ["result.txt"],
  idempotence: "replay_safe"
};

const descriptor: ToolDescriptor = {
  name: "write",
  description: "write",
  inputSchema: { type: "object" },
  possibleEffects: ["filesystem.write"],
  executionMode: "parallel",
  resourceKeys: [],
  approval: "prompt",
  idempotent: true,
  timeoutMs: 5_000
};

function runtimeSession(): RuntimeSession {
  const session = runtimeSessionFixture({ execution: { controller: new AbortController() } });
  session.durable.state.phase = "tool_pending";
  session.durable.state.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  session.durable.state.pendingTools = [{
    request: { callId: call.id, name: call.name, arguments: call.arguments },
    modelTurn: { turnId: 1, effectRevision: 1 },
    approval: "not_required",
    started: false
  }];
  return session;
}

function replacementWaiter(): ApprovalWaiter {
  return { effects: ["filesystem.write"], resolve: () => undefined };
}

describe("approval emission failure cleanup", () => {
  it.each([1, 2])("cleans the local waiter and restarts its deadline when emit %i fails", async (failAt) => {
    const session = runtimeSession();
    const emitted: string[] = [];
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "ask" } as never,
      emit: (async (_session: RuntimeSession, type: string) => {
        emitted.push(type);
        if (emitted.length === failAt) throw new Error(`emit ${failAt} failed`);
        return {};
      }) as never
    });

    await expect(coordinator.decision(session, {
      call,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor,
      plan
    }, new AbortController().signal)).rejects.toThrow(`emit ${failAt} failed`);

    expect(session.interaction.approvals.size).toBe(0);
    expect(session.execution.deadlineTimer).not.toBeNull();
    expect(emitted).toEqual(failAt === 1
      ? ["tool.approval_requested"]
      : ["tool.approval_requested", "run.suspended", "tool.approval_resolved"]);
    if (session.execution.deadlineTimer) clearTimeout(session.execution.deadlineTimer);
  });

  it("does not delete a concurrently replaced local waiter", async () => {
    const session = runtimeSession();
    const replacement = replacementWaiter();
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "ask" } as never,
      emit: (async () => {
        session.interaction.approvals.set(call.id, replacement);
        throw new Error("request emit failed");
      }) as never
    });

    await expect(coordinator.decision(session, {
      call,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor,
      plan
    }, new AbortController().signal)).rejects.toThrow("request emit failed");
    expect(session.interaction.approvals.get(call.id)).toBe(replacement);
  });

  it("cleans a delegated waiter after emit failure without deleting a replacement", async () => {
    const cleanSession = runtimeSession();
    cleanSession.durable.state.phase = "ready_model";
    await expect(requestDelegatedApproval(cleanSession, {
      requestId: "delegated",
      childId: "child",
      callId: "child-call",
      toolName: "exec",
      effects: ["network"],
      reason: "network"
    }, new AbortController().signal, (async () => {
      throw new Error("delegated emit failed");
    }) as never)).rejects.toThrow("delegated emit failed");
    expect(cleanSession.interaction.approvals.size).toBe(0);

    const replacedSession = runtimeSession();
    replacedSession.durable.state.phase = "ready_model";
    const replacement = replacementWaiter();
    await expect(requestDelegatedApproval(replacedSession, {
      requestId: "delegated",
      childId: "child",
      callId: "child-call",
      toolName: "exec",
      effects: ["network"],
      reason: "network"
    }, new AbortController().signal, (async () => {
      replacedSession.interaction.approvals.set("delegated", replacement);
      throw new Error("delegated emit failed");
    }) as never)).rejects.toThrow("delegated emit failed");
    expect(replacedSession.interaction.approvals.get("delegated")).toBe(replacement);
  });
});
