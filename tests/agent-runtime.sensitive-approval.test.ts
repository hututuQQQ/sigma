import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult
} from "../packages/agent-execution/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type ToolCallPlan
} from "../packages/agent-protocol/src/index.js";
import { createChildAgentFactory, createRuntime } from "../packages/agent-runtime/src/testing.js";
import { createApprovalBinding } from "../packages/agent-runtime/src/approval-binding.js";
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
import { completeAgentEventPayload } from "./testkit/agent-event-fixtures.js";

const fixtures: string[] = [];
// The fake broker accepts these explicit test entry points; production obtains
// the equivalent closed-world alias list from a successful broker connection.
const fixtureRuntimeCommands = ["host-fixture", "policy-fixture", "resume-fixture"];

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

const recoveredWritePlan: ToolCallPlan = {
  exactEffects: ["filesystem.write"],
  readPaths: ["result.txt"],
  writePaths: ["result.txt"],
  network: "none",
  processMode: "none",
  checkpointScope: ["result.txt"],
  idempotence: "replay_safe"
};

async function appendRecoveredWriteApproval(
  store: SegmentedJsonlStore,
  workspacePath: string,
  options: {
    pendingContent: string;
    presentedContent: string;
    presentedToolName?: string;
    durablePlan: boolean;
  }
): Promise<number> {
  const call = fakeToolCall("recovered-write", "write", {
    path: "result.txt", content: options.pendingContent
  });
  const stored: AgentEventEnvelope[] = [];
  const append = (type: AgentEventEnvelope["type"], payload: AgentEventEnvelope["payload"]): void => {
    stored.push(fixtureEvent(stored.length + 1, type, payload));
  };
  append("session.created", { workspacePath, mode: "change" });
  append("plan.updated", { previousRevision: 0, plan: {
    revision: 1, goal: "write result", activeNodeId: "root", nodes: [{
      id: "root", title: "write result", dependencies: [], status: "in_progress",
      owner: { kind: "root" }, acceptanceCriteria: ["result written"], evidence: []
    }]
  } });
  append("run.started", { mode: "change" });
  append("user.message", { text: "write result" });
  append("model.started", { turnId: 1, effectRevision: 4 });
  append("diagnostic", {
    kind: "model.tool_policy", turnId: 1, effectRevision: 4,
    allowedToolNames: [call.name], terminalOnly: false
  });
  append("model.completed", {
    turnId: 1, effectRevision: 4,
    message: { role: "assistant", content: "", toolCalls: [call] },
    finishReason: "tool_calls", toolCalls: [call]
  });
  append("tool.requested", {
    turnId: 1, effectRevision: 4, callId: call.id, name: call.name, arguments: call.arguments
  });
  if (options.durablePlan) {
    append("execution.planned", {
      executionId: call.id, toolCallId: call.id, plan: recoveredWritePlan
    });
  }
  append("tool.approval_requested", {
    turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id,
    toolName: options.presentedToolName ?? call.name,
    arguments: { path: "result.txt", content: options.presentedContent },
    effects: ["filesystem.write"],
    ...(options.durablePlan ? { plan: recoveredWritePlan } : {})
  });
  append("run.suspended", {
    turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id,
    message: "approval required", remainingDeadlineMs: 60_000
  });
  for (const event of stored) await store.append(event, event.seq - 1);
  return stored.length;
}

async function nextEventAfter(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  afterSeq: number,
  types: readonly AgentEventEnvelope["type"][]
): Promise<AgentEventEnvelope> {
  const signal = AbortSignal.timeout(15_000);
  for await (const event of runtime.subscribe(sessionId, signal)) {
    if (event.seq > afterSeq && types.includes(event.type)) return event;
  }
  throw new Error(`No ${types.join("/")} event followed seq ${afterSeq}.`);
}

async function cancelAndRelease(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  reason: string
): Promise<void> {
  try {
    await runtime.command({ type: "cancel", sessionId, reason });
  } finally {
    // Effect quiescence does not include the run-loop's terminal event,
    // snapshot, and command-owner writes. releaseSession waits for both.
    await runtime.releaseSession(sessionId);
  }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("sensitive per-call approvals", () => {
  it("uses the strictest runtime and profile permission mode", () => {
    expect(profilePermissionMode(
      { permissionMode: "deny" },
      { services: { profile: { profile: { permissionMode: "auto" } } } } as never
    )).toBe("deny");
    expect(profilePermissionMode(
      { permissionMode: "auto" },
      { services: { profile: { profile: { permissionMode: "deny" } } } } as never
    )).toBe("deny");
  });

  it("canonically binds the exact tool identity and complete JSON arguments", () => {
    const first = createApprovalBinding("session", "run", {
      id: "call", name: "write", arguments: { z: [1, true, null], a: { y: "值", x: -0 } }
    }, recoveredWritePlan, ["filesystem.write"]);
    const reordered = createApprovalBinding("session", "run", {
      id: "call", name: "write", arguments: { a: { x: 0, y: "值" }, z: [1, true, null] }
    }, recoveredWritePlan, ["filesystem.write"]);
    expect(reordered.planEffectsDigest).toBe(first.planEffectsDigest);
    expect(createApprovalBinding("session", "run", {
      id: "call", name: "delete_file", arguments: { a: { x: 0, y: "值" }, z: [1, true, null] }
    }, recoveredWritePlan, ["filesystem.write"]).planEffectsDigest).not.toBe(first.planEffectsDigest);
    expect(createApprovalBinding("session", "run", {
      id: "call", name: "write", arguments: { a: { x: 0, y: "changed" }, z: [1, true, null] }
    }, recoveredWritePlan, ["filesystem.write"]).planEffectsDigest).not.toBe(first.planEffectsDigest);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const argumentsValue of [
      { invalid: Number.NaN },
      { invalid: undefined },
      { invalid: "\ud800" },
      cyclic
    ]) {
      expect(() => createApprovalBinding("session", "run", {
        id: "call", name: "write", arguments: argumentsValue as never
      }, recoveredWritePlan, ["filesystem.write"])).toThrow(/Approval authority/u);
    }
  });

  it("prompts for every full-network call in ask mode and never persists always_allow", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-network-ask-"));
      fixtures.push(root);
      const requests: ExecutionRequest[] = [];
      const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
      const runtime = createRuntime({
        gateway: new SmokeFakeGateway([networkTurn("network-one"), networkTurn("network-two"), fakeFinalTurn()]),
        tools: registerBuiltinTools(new EffectToolRegistry(), {
          broker: broker(requests), sandboxMode: "required", networkMode: "none",
          runtimeCommands: fixtureRuntimeCommands
        }),
        store,
        storeRootDir: path.join(root, "state"),
        permissionMode: "ask",
        runDeadlineMs: 60_000
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
  });

  it("auto-resolves each full-network call with a fresh runtime-bound grant", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-network-auto-"));
    fixtures.push(root);
    const requests: ExecutionRequest[] = [];
    const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("network-one"), networkTurn("network-two"), fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker(requests), sandboxMode: "required", networkMode: "none",
        runtimeCommands: fixtureRuntimeCommands
      }),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Run two network checks." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.policy.network === "full"
      && request.policy.networkApproved === true)).toBe(true);
    const stored = await events(store, session.sessionId);
    expect(stored.filter((event) => event.type === "tool.approval_requested"))
      .toHaveLength(2);
    expect(stored.filter((event) => event.type === "tool.approval_requested")
      .every((event) => (event.payload as { approvalMode?: string }).approvalMode === "automatic")).toBe(true);
    expect(stored.filter((event) => event.type === "tool.approval_resolved")
      .every((event) => event.authority === "runtime"
        && (event.payload as { decision?: string }).decision === "allow")).toBe(true);
    expect(stored.some((event) => event.type === "run.suspended")).toBe(false);
  });

  it("does not charge explicit human approval wait time to the active run deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-approval-deadline-"));
    fixtures.push(root);
    const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("slow-human"), fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker([]), runtimeCommands: fixtureRuntimeCommands
      }),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "ask",
      runDeadlineMs: 60_000
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
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker(requests), runtimeCommands: fixtureRuntimeCommands
      }),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "deny",
      runDeadlineMs: 60_000
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

  it.each([
    {
      label: "arguments",
      pendingContent: "CHANGED",
      presentedContent: "ORIGINAL",
      presentedToolName: "write",
      firstDecision: "always_allow" as const
    },
    {
      label: "tool identity",
      pendingContent: "same-content",
      presentedContent: "same-content",
      presentedToolName: "delete_file",
      firstDecision: "allow" as const
    }
  ])("re-prompts when recovered approval $label differs from the executable call", async ({
    pendingContent, presentedContent, presentedToolName, firstDecision
  }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-approval-authority-"));
    fixtures.push(root);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const lastSeq = await appendRecoveredWriteApproval(store, root, {
      pendingContent, presentedContent, presentedToolName, durablePlan: true
    });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([]),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir,
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    await runtime.command({ type: "resume", sessionId: "sensitive-session" });
    try {
      const freshRequest = nextEventAfter(
        runtime, "sensitive-session", lastSeq, ["tool.approval_requested", "tool.failed"]
      );
      await runtime.command({
        type: "approve", sessionId: "sensitive-session", requestId: "recovered-write", decision: firstDecision
      });
      await expect(freshRequest).resolves.toMatchObject({
        type: "tool.approval_requested",
        payload: {
          requestId: "recovered-write",
          toolName: "write",
          arguments: { path: "result.txt", content: pendingContent }
        }
      });
      await expect(readFile(path.join(root, "result.txt"), "utf8")).rejects.toThrow();

      const completed = nextEventAfter(runtime, "sensitive-session", lastSeq, ["tool.completed"]);
      await runtime.command({
        type: "approve", sessionId: "sensitive-session", requestId: "recovered-write", decision: "allow"
      });
      await expect(completed).resolves.toMatchObject({ type: "tool.completed" });
      await expect(readFile(path.join(root, "result.txt"), "utf8")).resolves.toBe(pendingContent);
    } finally {
      await cancelAndRelease(runtime, "sensitive-session", "test complete");
    }
  });

  it("does not activate a recovered unbound always_allow grant before a fresh prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-legacy-always-"));
    fixtures.push(root);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const lastSeq = await appendRecoveredWriteApproval(store, root, {
      pendingContent: "legacy", presentedContent: "legacy", durablePlan: false
    });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([]),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir,
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    await runtime.command({ type: "resume", sessionId: "sensitive-session" });
    try {
      const freshRequest = nextEventAfter(
        runtime, "sensitive-session", lastSeq, ["tool.approval_requested", "tool.failed"]
      );
      await runtime.command({
        type: "approve",
        sessionId: "sensitive-session",
        requestId: "recovered-write",
        decision: "always_allow"
      });
      await expect(freshRequest).resolves.toMatchObject({
        type: "tool.approval_requested",
        payload: {
          requestId: "recovered-write",
          effects: ["filesystem.read", "filesystem.write"],
          plan: {
            ...recoveredWritePlan,
            exactEffects: ["filesystem.read", "filesystem.write"]
          }
        }
      });
      await expect(readFile(path.join(root, "result.txt"), "utf8")).rejects.toThrow();
    } finally {
      await cancelAndRelease(runtime, "sensitive-session", "test complete");
    }
  });

  it("releaseSession waits for terminal persistence before fixture teardown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-approval-release-"));
    fixtures.push(root);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const append = store.append.bind(store);
    let terminalAppendStarted!: () => void;
    let allowTerminalAppend!: () => void;
    const terminalAppend = new Promise<void>((resolve) => { terminalAppendStarted = resolve; });
    const terminalAppendGate = new Promise<void>((resolve) => { allowTerminalAppend = resolve; });
    store.append = async (event, expectedSeq) => {
      if (event.type === "run.cancelled") {
        terminalAppendStarted();
        await terminalAppendGate;
      }
      return await append(event, expectedSeq);
    };
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("release-wait")]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker([]), runtimeCommands: fixtureRuntimeCommands
      }),
      store,
      storeRootDir,
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    let releasing: Promise<void> | undefined;
    try {
      const approval = nextEventAfter(runtime, session.sessionId, 0, ["tool.approval_requested"]);
      await runtime.command({
        type: "submit", sessionId: session.sessionId, text: "Wait for approval, then cancel."
      });
      await expect(approval).resolves.toMatchObject({ type: "tool.approval_requested" });
      await runtime.command({ type: "cancel", sessionId: session.sessionId, reason: "release test" });
      await terminalAppend;

      let released = false;
      releasing = runtime.releaseSession(session.sessionId).then(() => { released = true; });
      await Promise.resolve();
      expect(released).toBe(false);
      allowTerminalAppend();
      await releasing;
      expect(released).toBe(true);
    } finally {
      allowTerminalAppend();
      await (releasing ?? runtime.releaseSession(session.sessionId));
    }
  });

  it("re-authorizes a recovered network call with a fresh auto binding", async () => {
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
      fixtureEvent(6, "diagnostic", {
        kind: "model.tool_policy", turnId: 1, effectRevision: 4,
        allowedToolNames: [call.name], terminalOnly: false
      }),
      fixtureEvent(7, "model.completed", {
        turnId: 1, effectRevision: 4,
        message: { role: "assistant", content: "", toolCalls: [call] },
        finishReason: "tool_calls", toolCalls: [call]
      }),
      fixtureEvent(8, "tool.requested", {
        turnId: 1, effectRevision: 4, callId: call.id, name: call.name, arguments: call.arguments
      }),
      fixtureEvent(9, "execution.planned", {
        executionId: call.id, toolCallId: call.id, plan: {
          exactEffects: ["process.spawn.readonly", "network"], readPaths: ["."], writePaths: [],
          network: "full", processMode: "pipe", checkpointScope: [], idempotence: "non_replayable"
        }
      }),
      fixtureEvent(10, "tool.approval_requested", {
        turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id, toolName: call.name,
        effects: ["process.spawn.readonly", "network"]
      }),
      fixtureEvent(11, "run.suspended", {
        turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id, message: "approval required"
      }),
      { ...fixtureEvent(12, "tool.approval_resolved", {
        turnId: 1, effectRevision: 4, requestId: call.id, callId: call.id, decision: "allow"
      }), authority: "user" }
    ];
    for (const event of stored) await store.append(event, event.seq - 1);
    const requests: ExecutionRequest[] = [];
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker(requests), runtimeCommands: fixtureRuntimeCommands
      }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    await runtime.command({ type: "resume", sessionId: "sensitive-session" });
    const automaticRequest = (async () => {
      for await (const event of runtime.subscribe("sensitive-session")) {
        if (event.type === "tool.approval_requested" && event.seq > 12) return event;
      }
      throw new Error("missing automatic approval request");
    })();
    const approval = await automaticRequest;
    expect(approval.payload).toMatchObject({
      approvalMode: "automatic",
      arguments: call.arguments,
      effects: ["process.spawn.readonly", "network"],
      plan: {
        exactEffects: ["process.spawn.readonly", "network"],
        readPaths: ["."],
        writePaths: [],
        checkpointScope: [],
        network: "full",
        processMode: "pipe"
      }
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

  it("uses a fresh child auto grant instead of treating spawn delegation as approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-network-call-"));
    fixtures.push(root);
    const requests: ExecutionRequest[] = [];
    const store = new SegmentedJsonlStore({ rootDir: path.join(root, "state") });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([networkTurn("child-network"), fakeFinalTurn()]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker: broker(requests), runtimeCommands: fixtureRuntimeCommands
      }),
      store,
      storeRootDir: path.join(root, "state"),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const parent = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    const supervisor = new AgentSupervisor(createChildAgentFactory(() => runtime), 1);
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
    expect(requests).toHaveLength(1);
    expect(requests[0]?.policy.networkApproved).toBe(true);
    const parentEvents = await events(store, parent.sessionId);
    expect(parentEvents.some((event) => event.type === "tool.approval_requested"
      && (event.payload as { delegated?: boolean }).delegated === true)).toBe(false);
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
    payload: completeAgentEventPayload(type, payload)
  };
}
