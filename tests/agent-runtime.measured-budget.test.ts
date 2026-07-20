import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEventEnvelope,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
  ToolDescriptor,
  ToolExecutor
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { providerVisibleHistory } from "../packages/agent-runtime/src/model-budget-convergence.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

describe("provider-visible runtime history", () => {
  it("removes synthetic runtime completion calls and receipts while preserving the answer", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "finish" },
      {
        role: "assistant",
        content: "Original answer.",
        toolCalls: [{
          id: "runtime_completion_intent_1_2",
          name: "runtime_finalize",
          arguments: { summary: "Original answer." }
        }]
      },
      {
        role: "tool",
        toolCallId: "runtime_completion_intent_1_2",
        content: "Failed tool receipt ID: runtime_completion_intent_1_2"
      },
      { role: "developer", content: "Obtain current validation evidence." }
    ];
    expect(providerVisibleHistory(history)).toEqual([
      { role: "user", content: "finish" },
      { role: "assistant", content: "Original answer.", toolCalls: undefined },
      { role: "developer", content: "Obtain current validation evidence." }
    ]);
    expect(JSON.stringify(providerVisibleHistory(history))).not.toContain("runtime_finalize");
  });
});

class UnderestimatedGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "measured-usage";
  readonly maxTokensPerUtf8Byte = 1;
  streamCalls = 0;
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 100,
    tools: true,
    parallelTools: false,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  async complete(_request: ModelRequest): Promise<never> {
    throw new Error("This test consumes the streaming path.");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.streamCalls += 1;
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "measured-complete",
            name: "request_user_input",
            arguments: { message: "Measured usage was settled." }
          }]
        },
        finishReason: "tool_calls",
        inputTokens: 130,
        outputTokens: 5
      }
    };
  }

  async countTokens(_messages: ModelMessage[], _tools: ModelToolDefinition[] = []): Promise<number> {
    return 80;
  }
}

class InspectableGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "inspectable";
  readonly maxTokensPerUtf8Byte = 1;
  readonly requests: ModelRequest[] = [];
  readonly capabilities: ModelCapabilities;

  constructor(private readonly responses: ModelResponse[], capabilities: Partial<ModelCapabilities> = {}) {
    this.capabilities = {
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
      tools: true,
      parallelTools: false,
      reasoning: true,
      structuredOutput: false,
      promptCache: true,
      tokenizer: "approximate",
      ...capabilities
    };
  }

  async complete(_request: ModelRequest): Promise<never> {
    throw new Error("This test consumes the streaming path.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error("Unexpected model request.");
    yield { type: "done", response };
  }

  async countTokens(): Promise<number> { return 100; }
}

class DeadlineCrossingGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "deadline-crossing";
  readonly maxTokensPerUtf8Byte = 1;
  readonly requests: ModelRequest[] = [];
  private firstStartedResolve!: () => void;
  private secondStartedResolve!: () => void;
  readonly firstStarted = new Promise<void>((resolve) => { this.firstStartedResolve = resolve; });
  readonly secondStarted = new Promise<void>((resolve) => { this.secondStartedResolve = resolve; });
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 128_000,
    maxOutputTokens: 64_000,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: true,
    tokenizer: "approximate"
  };

  async complete(_request: ModelRequest): Promise<never> {
    throw new Error("This test consumes the streaming path.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      this.firstStartedResolve();
      await new Promise((resolve) => setTimeout(resolve, 22_000));
      yield {
        type: "done",
        response: {
          message: {
            role: "assistant", content: "", toolCalls: [{
              id: "late-read", name: "read", arguments: { path: "not-started.txt" }
            }]
          },
          finishReason: "tool_calls", inputTokens: 100, outputTokens: 10
        }
      };
      return;
    }
    this.secondStartedResolve();
    yield { type: "done", response: requestInputResponse() };
  }

  async countTokens(): Promise<number> { return 100; }
}

function requestInputResponse(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "request-input",
        name: "request_user_input",
        arguments: { message: "Done inspecting recovery behavior." }
      }]
    },
    finishReason: "tool_calls",
    inputTokens: 100,
    outputTokens: 10
  };
}

async function storedEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("provider-measured model budget settlement", () => {
  it("uses 32K normally, one 16K continuation, then a forced 4K action after consecutive lengths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-length-recovery-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-length-recovery-state-"));
    const gateway = new InspectableGateway([{
      message: { role: "assistant", content: "partial", reasoningContent: "private truncated reasoning" },
      finishReason: "length",
      inputTokens: 100,
      outputTokens: 32_768
    }, {
      message: { role: "assistant", content: "still partial", reasoningContent: "more private reasoning" },
      finishReason: "length",
      inputTokens: 100,
      outputTokens: 16_384
    }, requestInputResponse()], { maxOutputTokens: 64_000 });
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto"
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "inspect recovery" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[0]).toMatchObject({ maxOutputTokens: 32_768 });
    expect(gateway.requests[0].toolChoice).toBeUndefined();
    expect(gateway.requests[1]).toMatchObject({ maxOutputTokens: 16_384 });
    expect(gateway.requests[1].toolChoice).toBeUndefined();
    expect(gateway.requests[2]).toMatchObject({ maxOutputTokens: 4_096, toolChoice: "required" });
    const recoveryPrompts = gateway.requests[1].messages.filter((message) =>
      message.content.includes("private reasoning is not replayed"));
    expect(recoveryPrompts).toHaveLength(1);
    expect(gateway.requests[2].messages.some((message) => message.content.includes("consecutive turns")))
      .toBe(true);
    expect(gateway.requests[0].messages.some((message) => message.content.includes("private reasoning is not replayed")))
      .toBe(false);
    expect(gateway.requests[1].messages.some((message) => message.reasoningContent === "private truncated reasoning"))
      .toBe(false);
    expect(gateway.requests[2].messages.some((message) => message.reasoningContent === "more private reasoning"))
      .toBe(false);
  });

  it("forces a terminal-only bounded turn before deadline settlement", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-converge-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-converge-state-"));
    const gateway = new InspectableGateway([requestInputResponse()], { maxOutputTokens: 64_000 });
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 40_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish promptly" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(gateway.requests[0]).toMatchObject({ maxOutputTokens: 4_096 });
    expect(gateway.requests[0].toolChoice).toBeUndefined();
    expect(gateway.requests[0].tools.map((tool) => tool.name).sort()).toEqual([
      "report_blocked", "request_user_input", "runtime_finalize"
    ]);
    expect(gateway.requests[0].messages.some((message) => message.content.includes("terminal-only")))
      .toBe(true);
  });

  it("accepts an explicit runtime_finalize only on the bound terminal-only turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-finalize-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-finalize-state-"));
    const store = new SegmentedJsonlStore({ rootDir: state });
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "terminal-finalize",
          name: "runtime_finalize",
          arguments: { summary: "The bounded terminal result is complete." }
        }]
      },
      finishReason: "tool_calls",
      inputTokens: 100,
      outputTokens: 10
    }], { maxOutputTokens: 64_000 });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 40_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish promptly" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: "The bounded terminal result is complete."
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.tools.map((tool) => tool.name).sort()).toEqual([
      "report_blocked", "request_user_input", "runtime_finalize"
    ]);
    const events = await storedEvents(store, session.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.completed",
      payload: expect.objectContaining({ callId: "terminal-finalize", ok: true })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "plan.updated",
      payload: expect.objectContaining({
        plan: expect.objectContaining({ nodes: [expect.objectContaining({ id: "root", status: "completed" })] })
      })
    }));
  });

  it("routes a natural stop on a terminal-only turn through the same completion coordinator", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-natural-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-natural-state-"));
    const store = new SegmentedJsonlStore({ rootDir: state });
    const gateway = new InspectableGateway([{
      message: { role: "assistant", content: "The natural terminal result is complete." },
      finishReason: "stop",
      inputTokens: 100,
      outputTokens: 10
    }], { maxOutputTokens: 64_000 });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 40_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish promptly" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: "The natural terminal result is complete."
    });
    expect(gateway.requests[0]!.toolChoice).toBeUndefined();
    const events = await storedEvents(store, session.sessionId);
    const completion = events.find((event) => event.type === "tool.completed"
      && String((event.payload as { callId?: unknown }).callId).startsWith("runtime_completion_intent_"));
    expect(completion).toBeDefined();
  });

  it.each(["read", "mixed_terminal_writer", "broad_maximum_terminal_writer"])(
    "rejects unoffered %s calls at the bound terminal turn before tool execution",
    async (unauthorizedName) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-policy-workspace-"));
      const state = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-policy-state-"));
      const store = new SegmentedJsonlStore({ rootDir: state });
      let mixedExecutions = 0;
      const tools = registerBuiltinTools(new EffectToolRegistry());
      tools.register({
        descriptor: {
          name: "mixed_terminal_writer",
          description: "A deliberately mixed-effect test tool.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          possibleEffects: ["outcome.propose", "filesystem.write"],
          executionMode: "sequential",
          resourceKeys: [],
          approval: "auto",
          idempotent: false,
          timeoutMs: 1_000
        },
        async execute(request) {
          mixedExecutions += 1;
          return {
            callId: request.callId,
            ok: true,
            output: "should not execute",
            observedEffects: ["outcome.propose", "filesystem.write"],
            artifacts: [],
            diagnostics: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          };
        }
      });
      tools.register({
        descriptor: {
          name: "broad_maximum_terminal_writer",
          description: "A terminal-looking test tool with a broader dynamic effect envelope.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          possibleEffects: ["outcome.propose"],
          maximumEffects: ["outcome.propose", "filesystem.write"],
          availableModes: ["change"],
          executionMode: "sequential",
          resourceKeys: [],
          approval: "auto",
          idempotent: false,
          timeoutMs: 1_000,
          prepare: async () => ({
            exactEffects: ["filesystem.write"],
            readPaths: [],
            writePaths: ["unexpected.txt"],
            network: "none",
            processMode: "none",
            checkpointScope: ["unexpected.txt"],
            idempotence: "non_replayable"
          })
        },
        async execute(request) {
          mixedExecutions += 1;
          return {
            callId: request.callId,
            ok: true,
            output: "should not execute",
            observedEffects: ["filesystem.write"],
            artifacts: [],
            diagnostics: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          };
        }
      });
      const unauthorized: ModelResponse = {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `unauthorized-${unauthorizedName}`,
            name: unauthorizedName,
            arguments: unauthorizedName === "read" ? { path: "seed.txt" } : {}
          }]
        },
        finishReason: "tool_calls",
        inputTokens: 100,
        outputTokens: 10
      };
      const gateway = new InspectableGateway([unauthorized, requestInputResponse()]);
      const runtime = createRuntime({
        gateway,
        store,
        storeRootDir: state,
        tools,
        permissionMode: "auto",
        runDeadlineMs: 40_000
      });
      const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
      await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish safely" });

      await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]!.tools.some((tool) => tool.name === unauthorizedName)).toBe(false);
      expect(gateway.requests[1]!.messages.some((message) =>
        message.content.includes("[tool_policy_violation]"))).toBe(true);
      const events = await storedEvents(store, session.sessionId);
      const unauthorizedCallId = `unauthorized-${unauthorizedName}`;
      expect(events.some((event) => event.type === "tool.started"
        && (event.payload as { callId?: unknown }).callId === unauthorizedCallId)).toBe(false);
      expect(events.some((event) => event.type === "tool.requested"
        && (event.payload as { callId?: unknown }).callId === unauthorizedCallId)).toBe(false);
      expect(mixedExecutions).toBe(0);
    }
  );

  it("rejects a non-terminal exact plan before every tool lifecycle event and executor call", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-exact-plan-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-exact-plan-state-"));
    const store = new SegmentedJsonlStore({ rootDir: state });
    const base = registerBuiltinTools(new EffectToolRegistry());
    let executions = 0;
    const descriptor: ToolDescriptor = {
      name: "spoofed_terminal_writer",
      description: "A terminal descriptor backed by an inconsistent test executor plan.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      possibleEffects: ["outcome.propose"],
      maximumEffects: ["outcome.propose"],
      availableModes: ["change"],
      executionMode: "sequential",
      resourceKeys: [],
      approval: "auto",
      idempotent: false,
      timeoutMs: 1_000
    };
    const allDescriptors = (): ToolDescriptor[] => [...base.descriptors(), descriptor]
      .sort((left, right) => left.name.localeCompare(right.name));
    const tools: ToolExecutor = {
      descriptors: allDescriptors,
      modelDescriptors: allDescriptors,
      async prepare(request, context) {
        if (request.name !== descriptor.name) return await base.prepare(request, context);
        return {
          exactEffects: ["filesystem.write"],
          readPaths: [],
          writePaths: ["unexpected.txt"],
          network: "none",
          processMode: "none",
          checkpointScope: ["unexpected.txt"],
          idempotence: "non_replayable"
        };
      },
      async execute(request, context) {
        if (request.name !== descriptor.name) return await base.execute(request, context);
        executions += 1;
        return {
          callId: request.callId,
          ok: true,
          output: "should not execute",
          observedEffects: ["filesystem.write"],
          artifacts: [],
          diagnostics: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        };
      }
    };
    const callId = "spoofed-terminal-call";
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: callId, name: descriptor.name, arguments: {} }]
      },
      finishReason: "tool_calls",
      inputTokens: 100,
      outputTokens: 10
    }, requestInputResponse()]);
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools,
      permissionMode: "auto",
      runDeadlineMs: 40_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish safely" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(gateway.requests[0]!.tools.some((tool) => tool.name === descriptor.name)).toBe(true);
    expect(executions).toBe(0);
    const recorded = await storedEvents(store, session.sessionId);
    for (const type of ["tool.requested", "execution.planned", "tool.started"] as const) {
      expect(recorded.some((event) => event.type === type
        && ((event.payload as { callId?: unknown }).callId === callId
          || (event.payload as { executionId?: unknown }).executionId === callId))).toBe(false);
    }
    expect(recorded).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({
        callId,
        diagnostics: ["tool_not_authorized_for_turn"]
      })
    }));
  });

  it("durably hands a late non-terminal call to a final terminal-only turn", async () => {
    vi.useFakeTimers();
    try {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-handoff-workspace-"));
      const state = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-handoff-state-"));
      const store = new SegmentedJsonlStore({ rootDir: state });
      const gateway = new DeadlineCrossingGateway();
      const runtime = createRuntime({
        gateway,
        store,
        storeRootDir: state,
        tools: registerBuiltinTools(new EffectToolRegistry()),
        permissionMode: "auto",
        runDeadlineMs: 60_000
      });
      const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costMicroUsd: 100_000_000,
        modelTurns: 200,
        toolCalls: 1_000,
        children: 32,
        maxDepth: 4
      });
      await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish before the deadline" });
      const outcome = runtime.waitForOutcome(session.sessionId);
      await gateway.firstStarted;
      await vi.advanceTimersByTimeAsync(22_000);
      await gateway.secondStarted;

      await expect(outcome).resolves.toMatchObject({ kind: "needs_input" });
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]!.tools.some((tool) => tool.name === "read")).toBe(true);
      expect(gateway.requests[1]!.tools.map((tool) => tool.name).sort()).toEqual([
        "report_blocked", "request_user_input", "runtime_finalize"
      ]);
      const events = await storedEvents(store, session.sessionId);
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({ diagnostics: ["deadline_terminal_handoff"] })
      }));
      expect(events.some((event) => event.type === "tool.started"
        && (event.payload as { callId?: unknown }).callId === "late-read")).toBe(false);
      expect(events.some((event) => event.type === "run.failed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a successful response when provider usage exceeds the admission reservation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-measured-budget-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-measured-budget-state-"));
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway: new UnderestimatedGateway(),
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "simple question" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: "measured-complete"
    });
    const events = await storedEvents(store, session.sessionId);
    expect(events.some((event) => event.type === "model.completed")).toBe(true);
    expect(events.some((event) => event.type === "model.failed")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "usage.recorded",
      payload: expect.objectContaining({ providerReported: true, inputTokens: 130, outputTokens: 5 })
    }));
    const committed = events.filter((event) => event.type === "budget.committed").at(-1);
    expect(committed?.payload).toEqual(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: "settle",
        status: "committed",
        totals: expect.objectContaining({ consumed: expect.objectContaining({ inputTokens: 130 }) })
      })
    }));
  });

  it("exposes only terminal tools when one model request fits", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-budget-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-budget-state-"));
    const gateway = new InspectableGateway([requestInputResponse()]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
      inputTokens: 150, outputTokens: 1_000, costMicroUsd: 10_000_000, modelTurns: 10,
      toolCalls: 1_000, children: 32, maxDepth: 4
    });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish within budget" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].toolChoice).toBeUndefined();
    expect(gateway.requests[0].tools.map((tool) => tool.name).sort()).toEqual([
      "report_blocked", "request_user_input", "runtime_finalize"
    ]);
  });

  it("returns typed budget exhaustion before an unfundable final request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exhausted-budget-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-exhausted-budget-state-"));
    const gateway = new InspectableGateway([]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
      inputTokens: 149, outputTokens: 1_000, costMicroUsd: 10_000_000, modelTurns: 10,
      toolCalls: 1_000, children: 32, maxDepth: 4
    });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish within budget" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure", code: "budget_exhausted"
    });
    expect(gateway.requests).toHaveLength(0);
  });

  it.each(["budget.committed", "budget.overrun", "usage.recorded", "model.completed"] as const)(
    "closes the final-response reservation once when %s persistence fails",
    async (failingType) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-model-settlement-workspace-"));
      const state = await mkdtemp(path.join(os.tmpdir(), "sigma-model-settlement-state-"));
      const store = new SegmentedJsonlStore({ rootDir: state });
      const append = store.append.bind(store);
      let injected = false;
      store.append = async (event, expectedSeq) => {
        if (!injected && event.type === failingType) {
          injected = true;
          throw new Error(`Injected ${failingType} persistence failure.`);
        }
        return await append(event, expectedSeq);
      };
      const gateway = new UnderestimatedGateway();
      const runtime = createRuntime({
        gateway,
        store,
        storeRootDir: state,
        tools: registerBuiltinTools(new EffectToolRegistry()),
        permissionMode: "auto",
        outputReserveTokens: 100
      });
      const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
        inputTokens: 120,
        outputTokens: 1_000,
        costMicroUsd: 10_000_000,
        modelTurns: 1_000,
        toolCalls: 1_000,
        children: 32,
        maxDepth: 4
      });
      await runtime.command({ type: "submit", sessionId: session.sessionId, text: "simple question" });

      await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
        kind: "recoverable_failure"
      });
      const events = await storedEvents(store, session.sessionId);
      const committed = events.filter((event) => event.type === "budget.committed");
      const mutation = (committed[0]?.payload as {
        mutation: {
          reservationId: string;
          status: string;
          consumed: { inputTokens: number; outputTokens: number };
          totals: {
            reserved: { inputTokens: number; outputTokens: number };
            consumed: { inputTokens: number; outputTokens: number };
          };
        };
      }).mutation;
      const reserved = events.find((event) => event.type === "budget.reserved"
        && (event.payload as { reservationId?: unknown }).reservationId === mutation.reservationId);
      const modelReservation = (reserved?.payload as {
        mutation?: { reservation?: { requested?: { inputTokens: number; outputTokens: number } } };
      }).mutation?.reservation;
      expect(injected).toBe(true);
      expect(gateway.streamCalls).toBe(1);
      expect(committed).toHaveLength(1);
      expect(mutation).toMatchObject({
        status: "committed",
        consumed: { inputTokens: 130, outputTokens: 5 },
        totals: {
          reserved: { inputTokens: 0, outputTokens: 0 },
          consumed: { inputTokens: 130, outputTokens: 5 }
        }
      });
      expect(modelReservation).toMatchObject({ requested: { inputTokens: 120, outputTokens: 150 } });
    }
  );
});
