import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyReasoningTrajectoryState,
  type AgentEventEnvelope,
  type ModelCapabilities,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent
} from "../packages/agent-protocol/src/index.js";
import {
  historyBlocks,
  projectReasoningSafeHistory,
  projectToolResultHistory,
  proposeReasoningTrajectoryTombstones,
  proposeToolResultPrune
} from "../packages/agent-context/src/index.js";
import { createRuntime, restoreStoredSession } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

class ThinkingGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "thinking-test";
  readonly capabilities: ModelCapabilities;
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly responses: ModelResponse[],
    overrides: Partial<ModelCapabilities> = {}
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
      requiresToolCallReasoningReplay: true,
      strictToolChoice: true,
      ...overrides
    };
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("The runtime test uses the streaming path.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error("Unexpected model request.");
    yield { type: "done", response };
  }

  async countTokens(): Promise<number> { return 100; }
}

async function events(
  store: SegmentedJsonlStore,
  sessionId: string
): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

function requestInputResponse(id: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      reasoningContent: "The write receipt is settled, so I should ask for the next instruction.",
      toolCalls: [{
        id,
        name: "request_user_input",
        arguments: { message: "The trajectory test is complete." }
      }]
    },
    finishReason: "tool_calls",
    inputTokens: 100,
    outputTokens: 20
  };
}

describe("thinking-provider trajectory integrity", () => {
  it("rejects a normal thinking tool call without reasoning before any side effect", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-thinking-missing-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-thinking-missing-state-"));
    const gateway = new ThinkingGateway([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "unsafe-write",
          name: "write",
          arguments: { path: "unsafe.txt", content: "must not exist" }
        }]
      },
      finishReason: "tool_calls",
      inputTokens: 100,
      outputTokens: 20
    }]);
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto"
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Create unsafe.txt."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure",
      code: "model_reasoning_trajectory_incomplete"
    });
    await expect(access(path.join(workspace, "unsafe.txt"))).rejects.toThrow();
    const stored = await events(store, session.sessionId);
    expect(stored.filter((event) => event.type === "tool.started")).toHaveLength(0);
    expect(stored.filter((event) => event.type === "model.completed")).toHaveLength(0);
  });

  it("keeps a strict non-thinking length tool call single-shot and starts a tombstoned trajectory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-thinking-strict-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "sigma-thinking-strict-state-"));
    const gateway = new ThinkingGateway([{
      message: {
        role: "assistant",
        content: "I need to act next.",
        reasoningContent: "The first turn ran out before taking an action."
      },
      finishReason: "length",
      inputTokens: 100,
      outputTokens: 8_192
    }, {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "strict-write-once",
          name: "write",
          arguments: { path: "once.txt", content: "written exactly once\n" }
        }]
      },
      finishReason: "length",
      inputTokens: 100,
      outputTokens: 100
    }, requestInputResponse("trajectory-done")], {
      strictToolChoiceDisablesReasoning: true
    });
    const store = new SegmentedJsonlStore({ rootDir: state });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: state,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      outputReserveTokens: 8_192
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Create once.txt, then stop for input."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input"
    });
    expect(gateway.requests.map((request) => request.toolChoice))
      .toEqual([undefined, "required", "auto"]);
    expect(gateway.requests.map((request) => request.maxOutputTokens))
      .toEqual([8_192, 8_192, 16_384]);
    expect(await readFile(path.join(workspace, "once.txt"), "utf8"))
      .toBe("written exactly once\n");
    const thirdHistory = gateway.requests[2]!.messages;
    expect(thirdHistory.some((message) =>
      message.content.includes("reasoning-trajectory-tombstone"))).toBe(true);
    expect(thirdHistory.some((message) =>
      message.toolCalls?.some((call) => call.id === "strict-write-once") === true)).toBe(false);

    const stored = await events(store, session.sessionId);
    expect(stored.filter((event) => event.type === "tool.completed"
      && (event.payload as { callId?: string }).callId === "strict-write-once")).toHaveLength(1);
    expect(stored.filter((event) =>
      event.type === "context.reasoning_trajectory_tombstoned")).toHaveLength(1);
    expect(stored.find((event) =>
      event.type === "model.completed"
      && (event.payload as { toolCalls?: Array<{ id: string }> }).toolCalls
        ?.some((call) => call.id === "trajectory-done"))?.payload).toMatchObject({
      message: {
        reasoningContent: expect.stringContaining("write receipt is settled"),
        toolCalls: [expect.objectContaining({ id: "trajectory-done" })]
      },
      toolCalls: [expect.objectContaining({ id: "trajectory-done" })]
    });
    const restored = await restoreStoredSession(store, session.sessionId, 30_000);
    expect(restored.state.reasoningTrajectory.blockDigests).toHaveLength(1);
    expect(restored.state.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      toolCalls: [expect.objectContaining({ id: "strict-write-once" })]
    }));
    expect(restored.state.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoningContent: expect.stringContaining("write receipt is settled"),
      toolCalls: [expect.objectContaining({ id: "trajectory-done" })]
    }));
  });

  it("preserves reasoning/tool blocks atomically through tool-result compaction", () => {
    const history = Array.from({ length: 3 }, (_, index) => {
      const callId = `large-${index}`;
      return [{
        role: "assistant" as const,
        content: "",
        reasoningContent: `reasoning-${index}`,
        toolCalls: [{ id: callId, name: "read", arguments: { path: `${index}.txt` } }]
      }, {
        role: "tool" as const,
        toolCallId: callId,
        content: "x".repeat(120_000)
      }];
    }).flat();
    const proposal = proposeToolResultPrune(history, undefined);
    expect(proposal.changed).toBe(true);
    const projected = projectToolResultHistory(history, proposal.state);

    expect(historyBlocks(projected).every((block) => block.wireSafe)).toBe(true);
    for (const message of projected.filter((item) =>
      item.role === "assistant" && (item.toolCalls?.length ?? 0) > 0)) {
      expect(message.reasoningContent).toMatch(/^reasoning-/u);
    }
    expect(projected.some((message) =>
      message.role === "assistant"
      && message.toolCalls === undefined
      && message.content.includes("non-executable observation summary"))).toBe(true);
  });

  it("converts a complete block with missing reasoning into one non-executable tombstone", () => {
    const history = [{
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: "settled-call", name: "write", arguments: { path: "a", content: "b" } }]
    }, {
      role: "tool" as const,
      toolCallId: "settled-call",
      content: "already settled"
    }];
    const proposal = proposeReasoningTrajectoryTombstones(
      history,
      emptyReasoningTrajectoryState(),
      true
    );
    const projected = projectReasoningSafeHistory(history, proposal.state, true);

    expect(proposal).toMatchObject({ changed: true, newlyTombstoned: 1 });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ role: "assistant" });
    expect(projected[0]).not.toHaveProperty("toolCalls");
    expect(projected[0]!.content).toContain("reasoning-trajectory-tombstone");
    expect(projected[0]!.content).not.toContain('"content":"b"');
    expect(history[0]!.toolCalls).toHaveLength(1);
  });
});
