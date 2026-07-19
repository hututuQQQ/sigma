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
  ModelToolDefinition
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
    expect(gateway.requests[0]).toMatchObject({ maxOutputTokens: 4_096, toolChoice: "required" });
    expect(gateway.requests[0].tools.map((tool) => tool.name).sort()).toEqual([
      "report_blocked", "request_user_input"
    ]);
    expect(gateway.requests[0].messages.some((message) => message.content.includes("Budget stage is terminal")))
      .toBe(true);
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
        "report_blocked", "request_user_input"
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
      ledger: expect.objectContaining({ consumed: expect.objectContaining({ inputTokens: 130 }) })
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
    expect(gateway.requests[0].toolChoice).toBe("required");
    expect(gateway.requests[0].tools.map((tool) => tool.name).sort()).toEqual([
      "report_blocked", "request_user_input"
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
      const ledger = (committed[0]?.payload as {
        ledger: {
          reservations: {
            status: string;
            requested: { inputTokens: number; outputTokens: number };
            consumed: { inputTokens: number; outputTokens: number };
          }[];
          reserved: { inputTokens: number; outputTokens: number };
          consumed: { inputTokens: number; outputTokens: number };
        };
      }).ledger;
      const modelReservation = ledger.reservations.find((reservation) => reservation.status === "committed");
      expect(injected).toBe(true);
      expect(gateway.streamCalls).toBe(1);
      expect(committed).toHaveLength(1);
      expect(ledger.reservations.filter((reservation) => reservation.status === "reserved")).toHaveLength(0);
      expect(ledger.reserved).toMatchObject({ inputTokens: 0, outputTokens: 0 });
      expect(ledger.consumed).toMatchObject({ inputTokens: 130, outputTokens: 5 });
      expect(modelReservation).toMatchObject({
        requested: { inputTokens: 120, outputTokens: 150 },
        consumed: { inputTokens: 130, outputTokens: 5 }
      });
    }
  );
});
