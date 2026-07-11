import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionBroker } from "../packages/agent-execution/src/index.js";
import {
  DEFAULT_PROFILE_BUDGET,
  freezeAgentProfile,
  type HookDefinition,
  type HookRunnerPort,
  type ResolvedAgentProfile
} from "../packages/agent-extensions/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type BudgetLimits,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "../packages/agent-protocol/src/index.js";
import {
  createConfiguredRuntime,
  createRuntime,
  type RuntimeCompositionConfig
} from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures: string[] = [];
const modelUsage = {
  inputTokens: 12,
  outputTokens: 3,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  providerReported: true,
  costMicroUsd: 0,
  latencyMs: 2,
  retryAttempt: 0
};

class HookGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "hook-policy";
  readonly capabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_048,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: true,
    promptCache: false,
    tokenizer: "approximate" as const
  };
  readonly requests: ModelRequest[] = [];
  countCalls = 0;

  constructor(private readonly content: string) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      message: { role: "assistant", content: this.content },
      finishReason: "stop",
      usage: modelUsage
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(request) };
  }

  async countTokens(): Promise<number> {
    this.countCalls += 1;
    return 100;
  }
}

function profile(id: string, hookIds: string[] = []): ReturnType<typeof freezeAgentProfile> {
  const value: ResolvedAgentProfile = {
    id,
    roleRoutes: {
      orchestrator: "main",
      planner: `${id}-planner`,
      reviewer: "review"
    },
    toolAllow: null,
    toolDeny: [],
    skills: [],
    hooks: hookIds,
    permissionMode: "deny",
    budget: { ...DEFAULT_PROFILE_BUDGET },
    mutationPolicy: {
      requirePlanBeforeMutation: true,
      checkpointBeforeMutation: true,
      reviewNonDocumentationChanges: true
    },
    allowedChildProfiles: []
  };
  return freezeAgentProfile(value);
}

function hook(profileId: string, overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    id: "model-policy",
    event: "session_start",
    kind: "agent_profile",
    profileId,
    prompt: "Evaluate whether this session may start.",
    required: true,
    timeoutMs: 5_000,
    ...overrides
  } as HookDefinition;
}

function limits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return {
    inputTokens: 10_000,
    outputTokens: 2_000,
    costMicroUsd: 1_000_000,
    modelTurns: 10,
    toolCalls: 10,
    children: 1,
    maxDepth: 1,
    ...overrides
  };
}

function unusedBroker(): ExecutionBroker {
  const fail = async (): Promise<never> => await Promise.reject(new Error("broker must not run"));
  return {
    lostProcessHandles: [],
    connect: fail,
    doctor: fail,
    execute: fail,
    spawn: fail,
    poll: fail,
    write: fail,
    terminate: fail,
    close: async () => undefined
  };
}

function configured(workspace: string): RuntimeCompositionConfig {
  return {
    workspace,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    permissionMode: "deny",
    runDeadlineSec: 30,
    modelDeadlineSec: 10,
    streamIdleSec: 5,
    maxParallelTools: 1,
    maxParallelAgents: 1,
    mcpServers: [],
    mcpSource: "none"
  };
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("production agent-profile hook runner", () => {
  it("runs through configured-runtime without an injected agent-profile runner", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-profile-hook-configured-"));
    fixtures.push(workspace);
    const gateway = new HookGateway("{}");
    const runtime = await createConfiguredRuntime(configured(workspace), {
      stateRootDir: path.join(workspace, "state"),
      executionBroker: unusedBroker(),
      gatewayFactory: () => gateway,
      hookDefinitions: [hook("standard")]
    }, { connectMcp: false });
    try {
      const session = await runtime.runtime.createSession({ workspacePath: workspace, mode: "analyze" });
      expect(session.sessionId).toBeTruthy();
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]?.tools).toEqual([]);
      expect(gateway.requests[0]?.messages).toHaveLength(2);
      expect(gateway.requests[0]?.messages[0]?.content).toContain("no tools, filesystem, process, child-agent, or network access");
      const stored = new SegmentedJsonlStore({ rootDir: runtime.storeRootDir });
      const events = [];
      for await (const event of stored.events(session.sessionId)) events.push(event);
      expect(events.find((event) => event.type === "customization.frozen")?.payload)
        .toMatchObject({ hookCount: 1, profileCount: 1 });
      expect(events.find((event) => event.type === "usage.recorded")?.payload)
        .toMatchObject({ role: "planner", providerReported: true });
      expect(events.some((event) => event.type === "hook.completed")).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("resolves the hook target profile deterministically and shares the session budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-profile-hook-route-"));
    fixtures.push(root);
    const gateway = new HookGateway("{}");
    const rootProfile = profile("root", ["model-policy"]);
    const policyProfile = profile("policy");
    const routed: Array<{ role: string; profileId?: string }> = [];
    const runtime = createRuntime({
      gateway,
      gatewayForRole: (role, selected) => {
        routed.push({ role, profileId: selected?.profile.id });
        return gateway;
      },
      tools: new EffectToolRegistry(),
      store: new SegmentedJsonlStore({ rootDir: root }),
      storeRootDir: root,
      profile: rootProfile,
      profileSource: "home",
      availableProfiles: [{ profile: policyProfile, source: "home" }],
      hooks: [hook("policy")],
      budgetLimits: limits()
    });
    const session = await runtime.createSession({ workspacePath: root, mode: "analyze" });
    expect(routed).toContainEqual({ role: "planner", profileId: "policy" });
    expect(runtime.sessionBudget(session.sessionId)).toMatchObject({
      consumed: { inputTokens: 12, outputTokens: 3, modelTurns: 1 },
      reserved: { inputTokens: 0, outputTokens: 0, modelTurns: 0 }
    });
  });

  it("fails before tokenization or model execution when the shared budget is exhausted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-profile-hook-budget-"));
    fixtures.push(root);
    const gateway = new HookGateway("{}");
    const selected = profile("budget-root", ["model-policy"]);
    const runtime = createRuntime({
      gateway,
      tools: new EffectToolRegistry(),
      store: new SegmentedJsonlStore({ rootDir: root }),
      storeRootDir: root,
      profile: selected,
      hooks: [hook("budget-root")],
      budgetLimits: limits({ modelTurns: 0 })
    });
    await expect(runtime.createSession({ workspacePath: root, mode: "analyze" }))
      .rejects.toMatchObject({ code: "hook_gate_denied" });
    expect(gateway.countCalls).toBe(0);
    expect(gateway.requests).toHaveLength(0);
  });

  it("charges usage but fails closed on invalid model JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-profile-hook-json-"));
    fixtures.push(root);
    const gateway = new HookGateway("```json\n{}\n```");
    const selected = profile("invalid-root", ["model-policy"]);
    const store = new SegmentedJsonlStore({ rootDir: root });
    const runtime = createRuntime({
      gateway,
      tools: new EffectToolRegistry(),
      store,
      storeRootDir: root,
      profile: selected,
      hooks: [hook("invalid-root")]
    });
    await expect(runtime.createSession({ workspacePath: root, mode: "analyze" }))
      .rejects.toMatchObject({
        code: "hook_gate_denied",
        outcome: expect.objectContaining({ status: "failed", reason: expect.stringContaining("invalid JSON") })
      });
    expect(gateway.requests).toHaveLength(1);
    const sessions = await store.listSessions();
    const events = [];
    for await (const event of store.events(sessions[0]!.sessionId)) events.push(event);
    expect(events.some((event) => event.type === "usage.recorded")).toBe(true);
    expect(events.some((event) => event.type === "hook.failed")).toBe(true);
  });

  it("preserves an explicitly injected agent-profile runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-profile-hook-injected-"));
    fixtures.push(root);
    const gateway = new HookGateway("model must not run");
    const injected: HookRunnerPort = {
      run: vi.fn(async () => ({ ok: true, output: {}, durationMs: 1 }))
    };
    const selected = profile("injected-root", ["model-policy"]);
    const runtime = createRuntime({
      gateway,
      tools: new EffectToolRegistry(),
      store: new SegmentedJsonlStore({ rootDir: root }),
      storeRootDir: root,
      profile: selected,
      hooks: [hook("injected-root")],
      agentProfileHookRunner: injected
    });
    await expect(runtime.createSession({ workspacePath: root, mode: "analyze" })).resolves.toBeDefined();
    expect(injected.run).toHaveBeenCalledOnce();
    expect(gateway.requests).toHaveLength(0);
  });

  it("conservatively closes a durable hook-model reservation once after a crash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-profile-hook-crash-"));
    fixtures.push(root);
    const gateway = new HookGateway("{}");
    const selected = profile("recovery-root");
    const store = new SegmentedJsonlStore({ rootDir: root });
    const options = {
      gateway,
      tools: new EffectToolRegistry(),
      store,
      storeRootDir: root,
      profile: selected,
      profileSource: "home" as const
    };
    const first = createRuntime(options);
    const session = await first.createSession({ workspacePath: root, mode: "analyze" });
    const ledger = first.sessionBudget(session.sessionId);
    const requested = {
      inputTokens: 120,
      outputTokens: 40,
      costMicroUsd: 900,
      modelTurns: 1,
      toolCalls: 0,
      children: 0
    };
    const ownerId = `hook-model:recovery-root:model-policy:pre_model:required:${randomUUID()}`;
    const reservationId = randomUUID();
    ledger.reserved = { ...requested };
    ledger.reservations.push({
      reservationId,
      ownerId,
      status: "reserved",
      requested,
      consumed: {
        inputTokens: 0, outputTokens: 0, costMicroUsd: 0,
        modelTurns: 0, toolCalls: 0, children: 0
      },
      createdAt: new Date().toISOString()
    });
    const existing = [];
    for await (const event of store.events(session.sessionId)) existing.push(event);
    const last = existing.at(-1)!;
    await first.releaseSession(session.sessionId);
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: last.seq + 1,
      eventId: randomUUID(),
      sessionId: session.sessionId,
      runId: session.runId,
      occurredAt: new Date().toISOString(),
      type: "budget.reserved",
      authority: "runtime",
      payload: { reservationId, ledger }
    }, last.seq);

    const second = createRuntime(options);
    await second.command({ type: "resume", sessionId: session.sessionId });
    expect(second.sessionBudget(session.sessionId)).toMatchObject({
      consumed: requested,
      reserved: {
        inputTokens: 0, outputTokens: 0, costMicroUsd: 0,
        modelTurns: 0, toolCalls: 0, children: 0
      }
    });
    await second.releaseSession(session.sessionId);
    const third = createRuntime(options);
    await third.command({ type: "resume", sessionId: session.sessionId });
    await third.releaseSession(session.sessionId);

    const recovered = [];
    for await (const event of store.events(session.sessionId)) recovered.push(event);
    expect(recovered.filter((event) => event.type === "budget.committed"
      && (event.payload as { reservationId?: string }).reservationId === reservationId)).toHaveLength(1);
    expect(recovered.filter((event) => event.type === "usage.recorded"
      && (event.payload as { requestId?: string }).requestId === ownerId)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "planner",
          providerReported: false,
          inputTokens: requested.inputTokens,
          outputTokens: requested.outputTokens,
          costMicroUsd: requested.costMicroUsd
        })
      })
    ]);
    expect(recovered.filter((event) => event.type === "hook.failed"
      && (event.payload as { hookId?: string }).hookId === "model-policy")).toHaveLength(1);
    expect(recovered.filter((event) => event.type === "diagnostic"
      && (event.payload as { kind?: string }).kind === "hook_model_recovered")).toHaveLength(1);
  });
});
