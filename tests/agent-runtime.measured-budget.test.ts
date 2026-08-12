import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEventEnvelope,
  BudgetLedgerState,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
  ReviewEvidence
} from "../packages/agent-protocol/src/index.js";
import { replayBudgetLedgerEvent } from "../packages/agent-kernel/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import type {
  ReviewerInput,
  ReviewerPort
} from "../packages/agent-runtime/src/reviewer.js";
import { strictReviewProfileFixture } from "./testkit/agent-profile-fixture.js";

function measuredUsage(
  inputTokens: number,
  outputTokens: number
): ModelResponse["usage"] {
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerReported: true,
    costMicroUsd: 0,
    latencyMs: 1,
    retryAttempt: 0
  };
}

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
        usage: measuredUsage(130, 5)
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

  constructor(
    private readonly responses: ModelResponse[],
    capabilityOverrides: Partial<ModelCapabilities> = {},
    private readonly beforeResponse?: (request: ModelRequest) => void
  ) {
    this.capabilities = {
      contextWindowTokens: 128_000,
      maxOutputTokens: 32_768,
      tools: true,
      parallelTools: false,
      reasoning: true,
      structuredOutput: false,
      promptCache: true,
      tokenizer: "approximate",
      strictToolChoice: true,
      ...capabilityOverrides
    };
  }

  async complete(_request: ModelRequest): Promise<never> {
    throw new Error("This test consumes the streaming path.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.beforeResponse?.(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error("Unexpected model request.");
    yield { type: "done", response };
  }

  async countTokens(): Promise<number> { return 100; }
}

class ToolSchemaHeavyGateway extends InspectableGateway {
  override async countTokens(
    _messages: ModelMessage[],
    tools: ModelToolDefinition[] = []
  ): Promise<number> {
    return tools.length > 0 ? 200 : 100;
  }
}

class ContextRejectedGateway extends InspectableGateway {
  readonly budgetToolCounts: number[] = [];

  async budgetPlan(
    _messages: ModelMessage[],
    tools: ModelToolDefinition[],
    maxOutputTokens: number,
    remainingBudgetMicroUsd: number
  ) {
    this.budgetToolCounts.push(tools.length);
    if (tools.length > 0) {
      throw Object.assign(new Error("The route cannot admit this context."), {
        code: "model_route_unavailable",
        routeId: "default",
        rejected: [{
          modelSpecId: "fake/context-rejected",
          reason: "context",
          detail: "32001 tokens exceed candidate limits"
        }]
      });
    }
    const inputTokens = 150;
    const outputTokens = Math.ceil(maxOutputTokens * 1.5);
    return {
      estimatedInputTokens: 100,
      reservedInputTokens: inputTokens,
      reservedOutputTokens: outputTokens,
      reservedCostMicroUsd: 0,
      reservedModelTurns: 1,
      attemptReservations: [{ inputTokens, outputTokens, costMicroUsd: null }],
      constraints: {
        estimatedInputTokens: 100,
        maxOutputTokens,
        remainingBudgetMicroUsd,
        maxAttempts: 1
      }
    };
  }

  routingIdentity() {
    return { role: "orchestrator" as const, routeId: "default" };
  }
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
    usage: measuredUsage(100, 10)
  };
}

function stopResponse(content: string): ModelResponse {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage: measuredUsage(100, 10)
  };
}

async function storedEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

function replayBudget(events: AgentEventEnvelope[]): BudgetLedgerState {
  let ledger: BudgetLedgerState | undefined;
  for (const event of events) ledger = replayBudgetLedgerEvent(ledger, event);
  if (!ledger) throw new Error("The durable event stream did not initialize a budget ledger.");
  return ledger;
}

describe("provider-measured model budget settlement", () => {
  it("materializes the exact prompt-cache frame so the next request extends the prior prefix", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-prompt-prefix-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-prompt-prefix-state-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed\n", "utf8");
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read-once", name: "read", arguments: { path: "seed.txt" } }]
      },
      finishReason: "tool_calls",
      usage: measuredUsage(100, 10)
    }, requestInputResponse()]);
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto"
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Read seed.txt." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });

    expect(gateway.requests).toHaveLength(2);
    const firstMessages = gateway.requests[0]!.messages;
    const secondMessages = gateway.requests[1]!.messages;
    expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
    expect(firstMessages.some((message) => message.content.includes("runtime_state:budget"))).toBe(true);
    expect(JSON.stringify(firstMessages)).not.toContain("timeMs=");
    expect(gateway.requests[1]!.tools).toEqual(gateway.requests[0]!.tools);

    const promptEvents = (await storedEvents(store, session.sessionId))
      .filter((event) => event.type === "model.prompt_materialized");
    expect(promptEvents).toHaveLength(2);
    expect(promptEvents[0]!.payload).toMatchObject({
      cacheMode: "prefix_cache",
      toolSchemaDigest: (promptEvents[1]!.payload as { toolSchemaDigest: string }).toolSchemaDigest
    });
    expect((promptEvents[0]!.payload as { requestDigest: string }).requestDigest)
      .toMatch(/^[a-f0-9]{64}$/u);
    const observation = (promptEvents[0]!.payload as {
      traceObservation: {
        tokenAccuracy: string;
        estimatedTokens: Record<string, number>;
        visibleToolNames: string[];
      };
    }).traceObservation;
    expect(observation.tokenAccuracy).toBe("estimated");
    expect(observation.visibleToolNames).toEqual(
      gateway.requests[0]!.tools.map((tool) => tool.name).sort()
    );
    expect(observation.estimatedTokens.total).toBe(
      observation.estimatedTokens.systemBaseContext
      + observation.estimatedTokens.toolSchema
      + observation.estimatedTokens.conversationHistory
      + observation.estimatedTokens.toolResults
    );
    const receipt = (await storedEvents(store, session.sessionId))
      .find((event) => event.type === "tool.completed");
    expect(receipt?.payload).toMatchObject({
      traceObservation: {
        schemaVersion: 1,
        rawBytes: expect.any(Number),
        modelVisibleBytes: expect.any(Number),
        fullOutputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    const receiptPayload = receipt?.payload as {
      output: string;
      traceObservation: { rawBytes: number };
    };
    expect(receiptPayload.traceObservation.rawBytes).toBe(Buffer.byteLength(receiptPayload.output));
  });

  it("uses one clean higher-headroom retry and then stops on another length finish", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-length-recovery-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-length-recovery-state-"));
    const gateway = new InspectableGateway([1, 2, 3].map((attempt) => ({
      message: {
        role: "assistant",
        content: `partial ${attempt}`,
        reasoningContent: "private truncated reasoning"
      },
      finishReason: "length",
      usage: measuredUsage(100, 4_096)
    })));
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 4_096
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "inspect recovery" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure",
      code: "model_output_limit"
    });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests.map((request) => request.maxOutputTokens))
      .toEqual([4_096, 32_000]);
    expect(gateway.requests[0].toolChoice).toBeUndefined();
    expect(gateway.requests[1].toolChoice).toBe("auto");
    expect(gateway.requests[1].messages.some((message) =>
      message.content.includes("was discarded before any tool call could run")))
      .toBe(true);
    expect(gateway.requests[1].messages.some((message) =>
      message.reasoningContent?.includes("private truncated reasoning") === true)).toBe(false);
  });

  it("allows the clean retry to answer naturally when strict tool choice is unavailable", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-length-fallback-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-length-fallback-state-"));
    const gateway = new InspectableGateway([{
      message: { role: "assistant", content: "partial" },
      finishReason: "length",
      usage: measuredUsage(100, 8_192)
    }, {
      message: { role: "assistant", content: "Small complete answer." },
      finishReason: "stop",
      usage: measuredUsage(100, 20)
    }], { strictToolChoice: false });
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 8_192
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "answer after truncation" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: "Small complete answer."
    });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]).toMatchObject({
      toolChoice: "auto",
      maxOutputTokens: 32_000
    });
    expect(gateway.requests[1]!.tools?.length).toBeGreaterThan(0);
  });

  it("discards tool calls from a length finish and retries without side effects", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-length-tool-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-length-tool-state-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed\n", "utf8");
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "I will inspect the file.",
        toolCalls: [{ id: "length-read", name: "read", arguments: { path: "seed.txt" } }]
      },
      finishReason: "length",
      usage: measuredUsage(100, 4_096)
    }, requestInputResponse()]);
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 4_096
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Inspect seed.txt." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });

    expect(gateway.requests.map((request) => request.maxOutputTokens)).toEqual([4_096, 32_000]);
    expect(gateway.requests[1]!.messages.some((message) =>
      message.content.includes("was discarded before any tool call could run"))).toBe(true);
    expect(gateway.requests[1]!.messages.some((message) =>
      message.toolCalls?.some((call) => call.id === "length-read") === true)).toBe(false);
    const events = await storedEvents(store, session.sessionId);
    expect(events.filter((event) => event.type === "tool.completed"
      && (event.payload as { callId?: string }).callId === "length-read")).toHaveLength(0);
  });

  it("does not forecast a terminal budget stage while the hard ledger can fund a request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-converge-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-converge-state-"));
    const gateway = new InspectableGateway([requestInputResponse()]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 4_096,
      runDeadlineMs: 40_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "finish promptly" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(gateway.requests[0]).toMatchObject({ maxOutputTokens: 4_096 });
    expect(gateway.requests[0].toolChoice).toBeUndefined();
    expect(gateway.requests[0].tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read", "shell", "report_blocked", "request_user_input"])
    );
    expect(gateway.requests[0].tools.map((tool) => tool.name)).not.toContain("validate");
    expect(gateway.requests[0].messages.some((message) => message.content.includes("Budget stage is terminal")))
      .toBe(false);
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
        totals: expect.objectContaining({ consumed: expect.objectContaining({ inputTokens: 130 }) })
      })
    }));
  });

  it("uses a text-only final response when only one hard-ledger request fits", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-budget-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-terminal-budget-state-"));
    const gateway = new InspectableGateway([stopResponse("Final budget-aware status.")]);
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

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: "Final budget-aware status."
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].toolChoice).toBe("none");
    expect(gateway.requests[0].tools).toEqual([]);
    expect(gateway.requests[0].messages.some((message) =>
      message.content.includes("final model turn allowed"))).toBe(true);
  });

  it("preserves typed failure when measured usage consumes the next request budget", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-boundary-submit-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-boundary-submit-state-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed\n", "utf8");
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "I inspected the workspace before the resource boundary.",
        toolCalls: [{
          id: "read-before-boundary",
          name: "read",
          arguments: { path: "seed.txt" }
        }]
      },
      finishReason: "tool_calls",
      usage: measuredUsage(200, 10)
    }]);
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
      inputTokens: 300, outputTokens: 1_000, costMicroUsd: 10_000_000, modelTurns: 10,
      toolCalls: 1_000, children: 32, maxDepth: 4
    });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "inspect the workspace" });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      decisionAuthority: "resource_boundary"
    });
    expect(gateway.requests).toHaveLength(1);
    const events = await storedEvents(store, session.sessionId);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { kind: "recoverable_failure", code: "budget_exhausted" }
    });
  });

  it("uses a final text-only fallback when tool schemas no longer fit the measured ledger", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-context-fallback-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-context-fallback-state-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed\n", "utf8");
    const gateway = new ToolSchemaHeavyGateway([{
      message: {
        role: "assistant",
        content: "I inspected the workspace before the input boundary.",
        toolCalls: [{
          id: "read-before-context-fallback",
          name: "read",
          arguments: { path: "seed.txt" }
        }]
      },
      finishReason: "tool_calls",
      usage: measuredUsage(450, 10)
    }, stopResponse("Completed work preserved at the input boundary.")]);
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: state }),
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
      inputTokens: 600, outputTokens: 1_000, costMicroUsd: 10_000_000, modelTurns: 10,
      toolCalls: 1_000, children: 32, maxDepth: 4
    });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Inspect the workspace and report the result."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: "Completed work preserved at the input boundary."
    });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]!.tools.length).toBeGreaterThan(0);
    expect(gateway.requests[1]).toMatchObject({ toolChoice: "none", tools: [] });
    expect(gateway.requests[1]!.messages.some((message) =>
      message.content.includes("final model turn allowed"))).toBe(true);
  });

  it("recovers an all-context route rejection with one text-only terminal turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-route-context-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-route-context-state-"));
    const gateway = new ContextRejectedGateway([
      stopResponse("Context route recovered without replaying the failed request.")
    ]);
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Provide a concise status."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: "Context route recovered without replaying the failed request."
    });
    expect(gateway.budgetToolCounts[0]).toBeGreaterThan(0);
    expect(gateway.budgetToolCounts.at(-1)).toBe(0);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({ toolChoice: "none", tools: [] });
    const events = await storedEvents(store, session.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "diagnostic",
      payload: {
        kind: "context.capacity_recovery",
        source: "router",
        action: "terminal_fallback",
        routeId: "default",
        rejections: [{
          modelSpecId: "fake/context-rejected",
          detail: "32001 tokens exceed candidate limits"
        }]
      }
    }));
    expect(events.some((event) => event.type === "model.failed")).toBe(false);
  });

  it("continues useful work while an explicit deadline is still live", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-settlement-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-deadline-settlement-state-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed\n", "utf8");
    const startedAt = Date.now();
    let currentTime = startedAt;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    try {
      const gateway = new InspectableGateway([{
        message: {
          role: "assistant",
          content: "I am inspecting the workspace.",
          toolCalls: [{
            id: "read-before-explicit-deadline",
            name: "read",
            arguments: { path: "seed.txt" }
          }]
        },
        finishReason: "tool_calls",
        usage: measuredUsage(100, 10)
      }, stopResponse("Inspection completed.")], {}, () => {
        currentTime = startedAt + 15_000;
      });
      const store = new SegmentedJsonlStore({ rootDir: state });
      const runtime = createRuntime({
        gateway,
        store,
        storeRootDir: state,
        tools: registerBuiltinTools(new EffectToolRegistry()),
        permissionMode: "auto",
        outputReserveTokens: 100,
        runDeadlineMs: 20_000
      });
      const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
        inputTokens: 10_000, outputTokens: 1_000, costMicroUsd: 10_000_000, modelTurns: 10,
        toolCalls: 1_000, children: 32, maxDepth: 4
      });
      await runtime.command({
        type: "submit",
        sessionId: session.sessionId,
        text: "Inspect seed.txt."
      });

      await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
        kind: "completed"
      });
      expect(gateway.requests).toHaveLength(2);
      const events = await storedEvents(store, session.sessionId);
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool.completed",
        payload: expect.objectContaining({
          callId: "read-before-explicit-deadline"
        })
      }));
      expect(events.at(-1)?.type).toBe("run.completed");
    } finally {
      now.mockRestore();
    }
  });

  it("does not impose a wall-clock boundary when none was configured", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-model-boundary-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-model-boundary-state-"));
    await writeFile(path.join(workspace, "seed.txt"), "seed\n", "utf8");
    const startedAt = Date.now();
    let currentTime = startedAt;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    try {
      const gateway = new InspectableGateway([{
        message: {
          role: "assistant",
          content: "I am inspecting the workspace.",
          toolCalls: [{
            id: "read-without-run-deadline",
            name: "read",
            arguments: { path: "seed.txt" }
          }]
        },
        finishReason: "tool_calls",
        usage: measuredUsage(100, 10)
      }, stopResponse("Inspection completed without a task timer.")], {}, () => {
        currentTime = startedAt + 86_400_000;
      });
      const store = new SegmentedJsonlStore({ rootDir: state });
      const runtime = createRuntime({
        gateway,
        store,
        storeRootDir: state,
        tools: registerBuiltinTools(new EffectToolRegistry()),
        permissionMode: "auto",
        outputReserveTokens: 100
      });
      const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" }, {
        inputTokens: 10_000, outputTokens: 1_000, costMicroUsd: 10_000_000, modelTurns: 10,
        toolCalls: 1_000, children: 32, maxDepth: 4
      });
      await runtime.command({
        type: "submit",
        sessionId: session.sessionId,
        text: "Inspect seed.txt, then continue until interrupted."
      });

      await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
        kind: "completed"
      });
      expect(gateway.requests).toHaveLength(2);
      const events = await storedEvents(store, session.sessionId);
      expect(events.find((event) => event.type === "run.started")?.payload)
        .toEqual({ mode: "analyze" });
      expect(events).toContainEqual(expect.objectContaining({
        type: "diagnostic",
        payload: expect.objectContaining({
          kind: "deadline.stage",
          stage: "unbounded"
        })
      }));
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(replayBudget(events).reservations.every((item) => item.status !== "reserved")).toBe(true);
    } finally {
      now.mockRestore();
    }
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

  it("does not convert Strict budget exhaustion into a completion review", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-budget-review-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-budget-review-state-"));
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "write-result",
          name: "write",
          arguments: { path: "result.txt", content: "done\n" }
        }]
      },
      finishReason: "tool_calls",
      usage: measuredUsage(130, 5)
    }]);
    let reviewerCalls = 0;
    const reviewer: ReviewerPort = {
      reviewerId: "budget-boundary-reviewer",
      async review(input: ReviewerInput): Promise<ReviewEvidence> {
        reviewerCalls += 1;
        const deltaId = input.workspaceDeltas.at(-1)?.evidenceId;
        if (!deltaId) throw new Error("Expected a durable workspace delta.");
        const criteria = input.acceptanceCriteria?.length
          ? input.acceptanceCriteria
          : [input.goal];
        return {
          evidenceId: "budget-boundary-approval",
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: "passed",
          createdAt: "2026-07-24T00:00:00.000Z",
          producer: { authority: "runtime", id: "budget-boundary-reviewer" },
          summary: "The independent reviewer approved the current frontier.",
          data: {
            schemaVersion: 1,
            reviewerId: "budget-boundary-reviewer",
            verdict: "approved",
            findings: [],
            criteria: criteria.map((criterion) => ({
              criterion,
              status: "satisfied",
              evidence: [deltaId]
            })),
            requiredValidations: [],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            reviewBasisDigest: input.reviewBasisDigest,
            validationEvidenceIds: [],
            durableEvidenceIds: [deltaId],
            actualChecks: []
          }
        };
      }
    };
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      reviewer,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100,
      profile: strictReviewProfileFixture()
    });
    const session = await runtime.createSession({
      workspacePath: workspace,
      mode: "change"
    }, {
      inputTokens: 249,
      outputTokens: 1_000,
      costMicroUsd: 10_000_000,
      modelTurns: 20,
      toolCalls: 1_000,
      children: 32,
      maxDepth: 4
    });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Create result.txt containing done."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      decisionAuthority: "resource_boundary"
    });
    expect(gateway.requests).toHaveLength(1);
    expect(reviewerCalls).toBe(0);
    expect((await storedEvents(store, session.sessionId)).some((event) =>
      event.type === "review.started" || event.type === "review.completed"
    )).toBe(false);
  });

  it("preserves completed tool work before a Strict budget failure", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-budget-repair-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-budget-repair-state-"));
    const gateway = new InspectableGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "write-before-review",
          name: "write",
          arguments: { path: "result.txt", content: "done\n" }
        }]
      },
      finishReason: "tool_calls",
      usage: measuredUsage(130, 5)
    }, {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "inspect-during-repair",
          name: "read",
          arguments: { path: "result.txt" }
        }]
      },
      finishReason: "tool_calls",
      usage: measuredUsage(100, 5)
    }]);
    let reviewerCalls = 0;
    const reviewer: ReviewerPort = {
      reviewerId: "repair-budget-reviewer",
      async review(input: ReviewerInput): Promise<ReviewEvidence> {
        reviewerCalls += 1;
        const deltaId = input.workspaceDeltas.at(-1)?.evidenceId;
        if (!deltaId) throw new Error("Expected a durable workspace delta.");
        const criteria = input.acceptanceCriteria?.length
          ? input.acceptanceCriteria
          : [input.goal];
        const approved = reviewerCalls === 2;
        return {
          evidenceId: `repair-review-${reviewerCalls}`,
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: approved ? "passed" : "failed",
          createdAt: "2026-07-24T00:00:00.000Z",
          producer: { authority: "runtime", id: "repair-budget-reviewer" },
          summary: approved
            ? "The repaired evidence was approved."
            : "Inspect the written result before approval.",
          data: {
            schemaVersion: 1,
            reviewerId: "repair-budget-reviewer",
            verdict: approved ? "approved" : "changes_requested",
            findings: approved ? [] : [{
              actionable: true,
              severity: "error",
              summary: "Read the written result and submit the new evidence."
            }],
            criteria: criteria.map((criterion) => ({
              criterion,
              status: approved ? "satisfied" : "unverified",
              evidence: approved ? [deltaId] : []
            })),
            requiredValidations: approved ? [] : [{
              purpose: "Inspect the written result."
            }],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            reviewBasisDigest: input.reviewBasisDigest,
            validationEvidenceIds: [],
            durableEvidenceIds: approved ? [deltaId] : [],
            actualChecks: []
          }
        };
      }
    };
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      reviewer,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 100,
      profile: strictReviewProfileFixture()
    });
    const session = await runtime.createSession({
      workspacePath: workspace,
      mode: "change"
    }, {
      inputTokens: 330,
      outputTokens: 1_000,
      costMicroUsd: 10_000_000,
      modelTurns: 20,
      toolCalls: 1_000,
      children: 32,
      maxDepth: 4
    });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Create result.txt containing done."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      decisionAuthority: "resource_boundary"
    });
    expect(gateway.requests).toHaveLength(1);
    expect(reviewerCalls).toBe(0);
    const events = await storedEvents(store, session.sessionId);
    expect(events.some((event) =>
      event.type === "review.started" || event.type === "review.completed"
    )).toBe(false);
    expect(events.some((event) =>
      event.type === "tool.completed"
      && (event.payload as { callId?: string }).callId === "write-before-review"
    )).toBe(true);
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
      const ledger = replayBudget(events);
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
