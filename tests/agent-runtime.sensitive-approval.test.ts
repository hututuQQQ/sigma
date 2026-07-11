import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult
} from "../packages/agent-execution/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope
} from "../packages/agent-protocol/src/index.js";
import { createChildAgentFactory, createRuntime } from "../packages/agent-runtime/src/index.js";
import { profilePermissionMode } from "../packages/agent-runtime/src/profile-policy.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { AgentSupervisor } from "../packages/agent-supervisor/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeFinalTurn,
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";

const fixtures: string[] = [];

function executionResult(): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    stdout: "ok\n",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false
  };
}

function broker(requests: ExecutionRequest[]): ExecutionBroker {
  const unused = async (): Promise<never> => await Promise.reject(new Error("unused"));
  return {
    lostProcessHandles: [],
    connect: unused,
    doctor: unused,
    execute: async (request) => { requests.push(request); return executionResult(); },
    spawn: unused,
    poll: unused,
    write: unused,
    terminate: unused,
    close: async () => undefined
  };
}

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const values: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) values.push(event);
  return values;
}

async function approveEvery(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  count: number,
  decision: "allow" | "always_allow" = "always_allow"
): Promise<string[]> {
  const ids: string[] = [];
  for await (const event of runtime.subscribe(sessionId)) {
    if (event.type !== "tool.approval_requested") continue;
    const requestId = (event.payload as { requestId: string }).requestId;
    ids.push(requestId);
    await runtime.command({ type: "approve", sessionId, requestId, decision });
    if (ids.length === count) return ids;
  }
  return ids;
}

function networkTurn(callId: string) {
  return fakeToolTurn([fakeToolCall(callId, "exec", {
    executable: "policy-fixture",
    args: [],
    network: "full"
  })]);
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("sensitive per-call approvals", () => {
  it("uses the strictest runtime and profile permission mode", () => {
    expect(profilePermissionMode(
      { permissionMode: "deny" },
      { profile: { profile: { permissionMode: "auto" } } } as never
    )).toBe("deny");
    expect(profilePermissionMode(
      { permissionMode: "auto" },
      { profile: { profile: { permissionMode: "deny" } } } as never
    )).toBe("deny");
  });

  it.each(["ask", "auto"] as const)(
    "prompts for every full-network call in %s mode and never persists always_allow",
    async (permissionMode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `sigma-network-${permissionMode}-`));
      fixtures.push(root);
      const requests: ExecutionRequest[] = [];
      const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
      const runtime = createRuntime({
        gateway: new SmokeFakeGateway([networkTurn("network-one"), networkTurn("network-two"), fakeFinalTurn()]),
        tools: registerBuiltinTools(new EffectToolRegistry(), {
          broker: broker(requests), sandboxMode: "required", networkMode: "none"
        }),
        store,
        storeRootDir: path.join(root, "state"),
        permissionMode,
        runDeadlineMs: 10_000
      });
      const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
      const approvals = approveEvery(runtime, session.sessionId, 2);
      await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Run two network checks." });
      await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
      await expect(approvals).resolves.toEqual(["network-one", "network-two"]);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.policy.network === "full"
        && request.policy.networkApproved === true)).toBe(true);
      const stored = await events(store, session.sessionId);
      expect(stored.filter((event) => event.type === "tool.approval_requested")).toHaveLength(2);
      expect(stored.filter((event) => event.type === "tool.approval_resolved")
        .every((event) => (event.payload as { decision?: string }).decision === "allow")).toBe(true);
    }
  );

  it("does not charge explicit human approval wait time to the active run deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-approval-deadline-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("slow-human"), fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker: broker([]) }),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "ask",
      runDeadlineMs: 2_000
    });
    const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    const requested = (async () => {
      for await (const event of runtime.subscribe(session.sessionId)) {
        if (event.type === "tool.approval_requested") return;
      }
    })();
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Wait for my approval." });
    await requested;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await runtime.command({
      type: "approve", sessionId: session.sessionId, requestId: "slow-human", decision: "allow"
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const stored = await events(store, session.sessionId);
    expect(stored.find((event) => event.type === "run.suspended")?.payload)
      .toMatchObject({ remainingDeadlineMs: expect.any(Number) });
    expect(stored.find((event) => event.type === "tool.approval_resolved")?.payload)
      .toMatchObject({ deadlineAt: expect.any(String) });
  });

  it("deny mode blocks sensitive calls without producing a grant", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-network-deny-"));
    fixtures.push(root);
    const requests: ExecutionRequest[] = [];
    const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("network-denied"), fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker: broker(requests) }),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "deny",
      runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Try a network check." });
    await runtime.waitForOutcome(session.sessionId);
    expect(requests).toHaveLength(0);
    const stored = await events(store, session.sessionId);
    expect(stored.some((event) => event.type === "tool.approval_requested")).toBe(false);
    expect(stored.some((event) => event.type === "tool.failed"
      && (event.payload as { diagnostics?: string[] }).diagnostics?.includes("permission_denied"))).toBe(true);
  });

  it("binds unsafe-host authorization to the approved call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-host-approval-"));
    fixtures.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const requests: ExecutionRequest[] = [];
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("host-one", "exec", { executable: "host-fixture", args: [] })]),
        fakeFinalTurn()
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker(requests), sandboxMode: "unsafe", networkMode: "none"
      }),
      store: new SegmentedJsonlStore({ rootDir: path.join(root, "state") }),
      storeRootDir: path.join(root, "state"),
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const approval = approveEvery(runtime, session.sessionId, 1);
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Run the explicitly requested host command." });
    await runtime.waitForOutcome(session.sessionId);
    const approvedIds = await approval;
    expect(approvedIds).toEqual(["host-one"]);
    await expect(runtime.command({
      type: "approve", sessionId: session.sessionId, requestId: approvedIds[0]!, decision: "allow"
    })).rejects.toThrow("Unknown approval");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.policy).toMatchObject({
      sandbox: "unsafe",
      unsafeHostExecApproved: true,
      network: "none",
      networkApproved: false
    });
  });

  it("does not reuse an allowed sensitive approval after resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-network-resume-"));
    fixtures.push(root);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const call = fakeToolCall("sensitive-resume", "exec", {
      executable: "resume-fixture", args: [], network: "full"
    });
    const stored: AgentEventEnvelope[] = [
      fixtureEvent(1, "session.created", { workspacePath: root, mode: "analyze" }),
      fixtureEvent(2, "plan.updated", { previousRevision: 0, plan: {
        revision: 1, goal: "resume network", activeNodeId: "root", nodes: [{
          id: "root", title: "resume", dependencies: [], status: "in_progress",
          owner: { kind: "root" }, acceptanceCriteria: ["done"], evidence: []
        }]
      } }),
      fixtureEvent(3, "run.started", { mode: "analyze" }),
      fixtureEvent(4, "user.message", { text: "resume" }),
      fixtureEvent(5, "model.started", { turnId: 1, effectRevision: 4 }),
      fixtureEvent(6, "model.completed", {
        turnId: 1, effectRevision: 4,
        message: { role: "assistant", content: "", toolCalls: [call] },
        finishReason: "tool_calls", toolCalls: [call]
      }),
      fixtureEvent(7, "tool.requested", {
        turnId: 1, effectRevision: 4, callId: call.id, name: call.name, arguments: call.arguments
      }),
      fixtureEvent(8, "execution.planned", {
        executionId: call.id, toolCallId: call.id, plan: {
          exactEffects: ["process.spawn.readonly", "network"], readPaths: ["."], writePaths: [],
          network: "full", processMode: "pipe", checkpointScope: [], idempotence: "non_replayable"
        }
      }),
      fixtureEvent(9, "tool.approval_requested", {
        turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id, toolName: call.name,
        effects: ["process.spawn.readonly", "network"]
      }),
      fixtureEvent(10, "run.suspended", {
        turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id, message: "approval required"
      }),
      { ...fixtureEvent(11, "tool.approval_resolved", {
        turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id, decision: "allow"
      }), authority: "user" }
    ];
    for (const event of stored) await store.append(event, event.seq - 1);
    const requests: ExecutionRequest[] = [];
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker: broker(requests) }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    await runtime.command({ type: "resume", sessionId: "sensitive-session" });
    const reprompt = (async () => {
      for await (const event of runtime.subscribe("sensitive-session")) {
        if (event.type === "tool.approval_requested" && event.seq > 11) return event;
      }
      throw new Error("missing re-prompt");
    })();
    const approval = await reprompt;
    expect(requests).toHaveLength(0);
    await runtime.command({
      type: "approve",
      sessionId: "sensitive-session",
      requestId: (approval.payload as { requestId: string }).requestId,
      decision: "allow"
    });
    await runtime.waitForOutcome("sensitive-session");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.policy.networkApproved).toBe(true);
  });

  it("elevates every sensitive child request to the parent session user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-sensitive-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway(),
      tools: new EffectToolRegistry(),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "auto"
    });
    const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    for (const suffix of ["one", "two"]) {
      const requestId = `child:child-id:network-${suffix}`;
      const pending = runtime.requestDelegatedApproval(session.sessionId, {
        requestId,
        childId: "child-id",
        callId: `network-${suffix}`,
        toolName: "exec",
        effects: ["process.spawn.readonly", "network"],
        reason: "Child requests network."
      }, new AbortController().signal);
      const raised = (async () => {
        for await (const event of runtime.subscribe(session.sessionId)) {
          if (event.type === "tool.approval_requested"
            && (event.payload as { requestId?: string }).requestId === requestId) return event;
        }
        throw new Error("delegated approval not raised");
      })();
      await raised;
      await runtime.command({
        type: "approve", sessionId: session.sessionId, requestId, decision: "always_allow"
      });
      await expect(pending).resolves.toBe("allow");
    }
    const stored = await events(store, session.sessionId);
    expect(stored.filter((event) => event.type === "tool.approval_requested"
      && (event.payload as { delegated?: boolean }).delegated === true)).toHaveLength(2);
  });

  it("does not treat a spawn delegation as approval for a child network call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-network-call-"));
    fixtures.push(root);
    const requests: ExecutionRequest[] = [];
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("child-network"), fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker: broker(requests) }),
      store: new SegmentedJsonlStore({ rootDir: path.join(root, "state") }),
      storeRootDir: path.join(root, "state"),
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    const parent = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    const supervisor = new AgentSupervisor(createChildAgentFactory(() => runtime), 1);
    const parentApproval = (async () => {
      for await (const event of runtime.subscribe(parent.sessionId)) {
        if (event.type !== "tool.approval_requested"
          || (event.payload as { delegated?: boolean }).delegated !== true) continue;
        const requestId = (event.payload as { requestId: string }).requestId;
        expect(requests).toHaveLength(0);
        await runtime.command({
          type: "approve", sessionId: parent.sessionId, requestId, decision: "allow"
        });
        return requestId;
      }
      throw new Error("parent approval was not raised");
    })();
    const child = supervisor.spawn({
      parentId: parent.sessionId,
      instruction: "Run one network check.",
      workspacePath: root,
      intent: "analyze",
      delegatedEffects: ["filesystem.read", "process.spawn.readonly", "network"],
      metadata: { mode: "analyze" }
    });
    await expect(supervisor.join(child.id)).resolves.toMatchObject({
      status: "completed", result: { outcome: { kind: "completed" } }
    });
    await expect(parentApproval).resolves.toBe(`child:${child.id}:child-network`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.policy.networkApproved).toBe(true);
  });
});

function fixtureEvent(
  seq: number,
  type: AgentEventEnvelope["type"],
  payload: AgentEventEnvelope["payload"]
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: randomUUID(),
    sessionId: "sensitive-session",
    runId: "sensitive-run",
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    type,
    authority: "runtime",
    payload
  };
}
