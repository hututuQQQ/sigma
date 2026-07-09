import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { AgentEventBus, createToolRegistryFromTools, runAgent, type AgentEvent } from "../packages/agent-core/src/index.js";

class FakeModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-model";
  private index = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

class DefaultCompactionModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-default-compaction-model";
  readonly requests: ModelRequest[] = [];
  private mainIndex = 0;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    if (req.toolChoice === "none") {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            objective: "compact objective",
            current_plan: ["continue"],
            changed_files: [],
            key_decisions: ["kept tail"],
            failed_attempts: [],
            validation_evidence: [],
            unresolved_questions: [],
            next_actions: ["finish"]
          })
        }
      };
    }
    const responses: ModelResponse[] = [
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "large-1",
              type: "function",
              function: { name: "bash", arguments: { command: "printf '%05000d' 0" } }
            }
          ]
        }
      },
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "large-2",
              type: "function",
              function: { name: "bash", arguments: { command: "printf '%05000d' 0" } }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ];
    const response = responses[Math.min(this.mainIndex, responses.length - 1)];
    this.mainIndex += 1;
    return response;
  }
}

class StreamingModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-stream-model";
  readonly requests: ModelRequest[] = [];

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    throw new Error("complete should not be called when stream is available");
  }

  async *stream(req: ModelRequest) {
    this.requests.push(req);
    yield { type: "message_delta" as const, data: { delta: "hello " } };
    yield { type: "reasoning_delta" as const, data: { delta: "thinking" } };
    yield { type: "message_delta" as const, data: { delta: "world" } };
    yield { type: "usage" as const, data: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
    yield { type: "done" as const };
  }
}

class AbortStreamingModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-abort-stream-model";

  constructor(private readonly controller: AbortController) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    throw new Error("complete should not be called");
  }

  async *stream(_req: ModelRequest) {
    yield { type: "message_delta" as const, data: { delta: "partial" } };
    this.controller.abort();
    yield { type: "message_delta" as const, data: { delta: " ignored" } };
  }
}

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agent-loop-"));
}

describe("agent loop", () => {
  it("executes a bash tool call then stops on final assistant message", async () => {
    const dir = await tempWorkspace();
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "bash", arguments: { command: "printf done" } }
            }
          ]
        },
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
      },
      { message: { role: "assistant", content: "finished" } }
    ]);

    const result = await runAgent({
      instruction: "run a command",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      traceJsonlPath: path.join(dir, "trace.jsonl")
    });

    expect(result.status).toBe("completed");
    expect(result.finishReason).toBe("assistant_stop");
    expect(result.toolCalls).toBe(1);
    expect(result.commandsExecuted).toBe(1);
    await expect(readFile(path.join(dir, "trace.jsonl"), "utf8")).resolves.toContain("tool_end");
  });

  it("records generic failure patterns and nudges the next turn toward repair", async () => {
    const dir = await tempWorkspace();
    const summaryPath = path.join(dir, "summary.json");
    const eventBus = new AgentEventBus();
    const events: string[] = [];
    const agentEvents: AgentEvent[] = [];
    eventBus.on((event) => {
      events.push(event.type);
      agentEvents.push(event);
    });
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "segfault-like",
              type: "function",
              function: { name: "bash", arguments: { command: "exit 139" } }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "debug a failing command",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      eventBus,
      summaryJsonPath: summaryPath
    });

    expect(result.status).toBe("completed");
    expect(events).toContain("failure_analysis");
    const toolStart = agentEvents.find((event) => event.type === "tool_start");
    const failureAnalysis = agentEvents.find((event) => event.type === "failure_analysis");
    expect(failureAnalysis?.parentId).toBe(toolStart?.id);
    expect(result.failureAnalyses?.[0]).toMatchObject({ category: "segmentation_fault", confidence: expect.any(Number) });
    expect(result.workflow?.failure_patterns).toEqual([
      expect.objectContaining({ category: "segmentation_fault", count: 1, last_exit_code: 139 })
    ]);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.failure_analyses[0]).toMatchObject({ category: "segmentation_fault" });
    expect(
      model.requests[1].messages.some(
        (message) => message.role === "user" && message.content.includes("Workflow repair signal")
      )
    ).toBe(true);
  });

  it("compacts large tool arguments in trace files and follow-up model context", async () => {
    const dir = await tempWorkspace();
    const tracePath = path.join(dir, "trace.jsonl");
    const filler = "X".repeat(10000);
    const command = `printf ok\n# ${filler}`;
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "large-command",
              type: "function",
              function: { name: "bash", arguments: { command } }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    await runAgent({
      instruction: "run a large command",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      traceJsonlPath: tracePath
    });

    const historyAssistant = model.requests[1].messages.find(
      (message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "large-command"
    );
    expect(historyAssistant?.role).toBe("assistant");
    const compactedCommand = historyAssistant?.role === "assistant"
      ? (historyAssistant.toolCalls?.[0]?.function.arguments as { command?: string }).command
      : "";
    expect(compactedCommand).toContain("large command compacted");
    expect(compactedCommand?.length).toBeLessThan(4500);

    const trace = await readFile(tracePath, "utf8");
    expect(trace).toContain("large command compacted");
    expect(trace).not.toContain(filler);
  });

  it("executes write and edit tool calls", async () => {
    const dir = await tempWorkspace();
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "write-1",
              type: "function",
              function: { name: "write", arguments: { path: "hello.txt", content: "hello old", createDirs: true } }
            },
            {
              id: "edit-1",
              type: "function",
              function: {
                name: "edit",
                arguments: { path: "hello.txt", oldString: "old", newString: "new", expectedReplacements: 1 }
              }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "write then edit",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("completed");
    await expect(readFile(path.join(dir, "hello.txt"), "utf8")).resolves.toBe("hello new");
  });

  it("stops at max turns", async () => {
    const dir = await tempWorkspace();
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "read-forever",
              type: "function",
              function: { name: "read", arguments: { path: "missing.txt" } }
            }
          ]
        }
      }
    ]);

    const result = await runAgent({
      instruction: "loop",
      workspacePath: dir,
      modelClient: model,
      maxTurns: 1,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("max_turns");
  });

  it("nudges repeated identical tool calls then stops on continued repetition", async () => {
    const dir = await tempWorkspace();
    const events: AgentEvent[] = [];
    const bus = new AgentEventBus();
    bus.on((event) => events.push(event));
    const repeatedCall = {
      id: "read-repeat",
      type: "function" as const,
      function: { name: "read", arguments: { path: "missing.txt" } }
    };
    const model = new FakeModel([
      { message: { role: "assistant", toolCalls: [repeatedCall] } },
      { message: { role: "assistant", toolCalls: [{ ...repeatedCall, id: "read-repeat-2" }] } },
      { message: { role: "assistant", toolCalls: [{ ...repeatedCall, id: "read-repeat-3" }] } },
      { message: { role: "assistant", toolCalls: [{ ...repeatedCall, id: "read-repeat-4" }] } }
    ]);

    const result = await runAgent({
      instruction: "loop",
      workspacePath: dir,
      modelClient: model,
      maxTurns: 5,
      permissionMode: "yolo",
      eventBus: bus
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("loop_guard");
    expect(events.filter((event) => event.type === "loop_guard_triggered").map((event) => event.metadata?.action)).toEqual([
      "nudge",
      "stop"
    ]);
    expect(model.requests[3].messages.some((message) => message.role === "user" && message.content.includes("Loop guard"))).toBe(true);
  });

  it("compacts old messages without leaving an orphan tool message at the retained tail", async () => {
    const dir = await tempWorkspace();
    const summaryPath = path.join(dir, "summary.json");
    const eventBus = new AgentEventBus();
    const events: string[] = [];
    eventBus.on((event) => events.push(event.type));
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "large-1",
              type: "function",
              function: { name: "bash", arguments: { command: "printf '%05000d' 0" } }
            }
          ]
        }
      },
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "large-2",
              type: "function",
              function: { name: "bash", arguments: { command: "printf '%05000d' 0" } }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "make lots of output",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      maxTurns: 3,
      maxMessageHistoryChars: 1000,
      messageHistoryRetain: 2,
      compactionSummaryChars: 500,
      compactionMode: "deterministic",
      eventBus,
      summaryJsonPath: summaryPath
    });

    expect(result.status).toBe("completed");
    expect(events).toEqual(expect.arrayContaining(["context_compaction_start", "context_compaction_end"]));
    expect(result.contextCompactions?.[0]).toMatchObject({
      strategy: "deterministic",
      before_message_count: expect.any(Number),
      compacted_message_count: expect.any(Number),
      fallback_used: false
    });
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.context_compactions[0]).toMatchObject({ strategy: "deterministic" });
    const thirdRequestMessages = model.requests[2].messages;
    expect(thirdRequestMessages[0].role).toBe("system");
    expect(thirdRequestMessages[1]).toMatchObject({ role: "user", content: "make lots of output" });
    expect(thirdRequestMessages[2].role).toBe("user");
    expect((thirdRequestMessages[2] as { content?: string }).content).toContain(
      "Previous agent conversation compacted by the run controller."
    );
    expect(thirdRequestMessages[3].role).toBe("assistant");
  });

  it("uses model sub-session compaction by default with no tools", async () => {
    const dir = await tempWorkspace();
    const model = new DefaultCompactionModel();

    const result = await runAgent({
      instruction: "make lots of output",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      maxTurns: 3,
      maxMessageHistoryChars: 1000,
      messageHistoryRetain: 2,
      compactionSummaryChars: 500
    });

    expect(result.status).toBe("completed");
    const compactionRequest = model.requests.find((request) => request.toolChoice === "none");
    expect(compactionRequest).toMatchObject({ tools: [], toolChoice: "none" });
    expect(result.contextCompactions?.[0]).toMatchObject({
      strategy: "model_sub_session",
      fallback_used: false
    });
  });

  it("uses model context limits as an effective compaction budget", async () => {
    const dir = await tempWorkspace();
    const model = new DefaultCompactionModel();

    const result = await runAgent({
      instruction: "make lots of output",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      maxTurns: 3,
      messageHistoryRetain: 2,
      modelContextLimits: { contextChars: 1100, reservedOutputChars: 100 }
    });

    expect(result.status).toBe("completed");
    expect(result.contextBudget?.model_context_chars).toBe(1100);
    expect(result.contextBudget?.max_message_history_chars).toBe(1000);
    expect(result.contextCompactions?.[0]).toMatchObject({ strategy: "model_sub_session" });
  });

  it("uses streaming model deltas and emits token-level events", async () => {
    const dir = await tempWorkspace();
    const model = new StreamingModel();
    const controller = new AbortController();
    const eventBus = new AgentEventBus();
    const events: string[] = [];
    eventBus.on((event) => events.push(event.type));

    const result = await runAgent({
      instruction: "stream",
      workspacePath: dir,
      modelClient: model,
      eventBus,
      abortSignal: controller.signal
    });

    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe("hello world");
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    expect(events).toEqual(expect.arrayContaining(["assistant_delta", "reasoning_delta", "assistant_message"]));
    expect(model.requests[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("dispatches tool calls through the runtime and records context budget", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "a.txt"), "alpha", "utf8");
    await writeFile(path.join(dir, "b.txt"), "bravo", "utf8");
    const events: string[] = [];
    const bus = new AgentEventBus();
    bus.on((event) => events.push(event.type));
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            { id: "read-a", type: "function", function: { name: "read", arguments: { path: "a.txt" } } },
            { id: "read-b", type: "function", function: { name: "read", arguments: { path: "b.txt" } } }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "read files",
      workspacePath: dir,
      modelClient: model,
      eventBus: bus
    });

    expect(result.status).toBe("completed");
    expect(result.toolRuntime).toMatchObject({ queued: 2, completed: 2, parallel_batches: 1 });
    expect(result.contextBudget?.message_count).toBeGreaterThan(0);
    expect(events).toEqual(expect.arrayContaining(["turn_start", "context_budget", "tool_queued", "tool_start", "tool_end"]));
  });

  it("sends only model-visible tool result fields back to the model", async () => {
    const dir = await tempWorkspace();
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "secret-call",
              type: "function",
              function: { name: "secret_tool", arguments: {} }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);
    const registry = createToolRegistryFromTools([
      {
        definition: {
          type: "function",
          function: {
            name: "secret_tool",
            description: "visibility test tool",
            parameters: { type: "object", additionalProperties: false }
          }
        },
        risk: "read",
        runtime: { readOnly: true, supportsParallel: true },
        execute: async () => ({
          ok: true,
          modelContent: "visible output",
          uiContent: "visible ui output",
          modelMetadata: { safe: true },
          privateMetadata: { hiddenToken: "do-not-send" }
        })
      }
    ]);

    await runAgent({
      instruction: "call secret",
      workspacePath: dir,
      modelClient: model,
      toolRegistry: registry
    });

    const toolMessage = model.requests[1].messages.find((message) => message.role === "tool");
    expect(toolMessage?.role).toBe("tool");
    expect(toolMessage?.content).toContain("visible output");
    expect(toolMessage?.content).toContain("\"safe\":true");
    expect(toolMessage?.content).not.toContain("do-not-send");
    expect(toolMessage?.content).not.toContain("hiddenToken");
  });

  it("stores complete bash output artifacts through the runtime", async () => {
    const dir = await tempWorkspace();
    const payload = "SIGMA_FULL_OUTPUT_".repeat(80);
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "large-bash",
              type: "function",
              function: { name: "bash", arguments: { command: `printf '${payload}'` } }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "capture large output",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      maxToolOutputChars: 80
    });

    const artifact = result.toolRuntime?.artifacts[0];
    expect(artifact).toBeTruthy();
    const artifactPath = path.isAbsolute(artifact?.path ?? "") ? artifact?.path ?? "" : path.join(dir, artifact?.path ?? "");
    const artifactText = await readFile(artifactPath, "utf8");
    expect(artifactText).toContain(payload);
    expect(result.status).toBe("completed");
  });

  it("cancels before a model request", async () => {
    const dir = await tempWorkspace();
    const controller = new AbortController();
    controller.abort();
    const model = new FakeModel([{ message: { role: "assistant", content: "should not run" } }]);

    const result = await runAgent({
      instruction: "abort",
      workspacePath: dir,
      modelClient: model,
      abortSignal: controller.signal
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("cancelled");
    expect(model.requests).toHaveLength(0);
  });

  it("cancels during a model stream", async () => {
    const dir = await tempWorkspace();
    const controller = new AbortController();

    const result = await runAgent({
      instruction: "abort stream",
      workspacePath: dir,
      modelClient: new AbortStreamingModel(controller),
      abortSignal: controller.signal
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("cancelled");
  });

  it("cancels during a bash tool command", async () => {
    const dir = await tempWorkspace();
    const controller = new AbortController();
    const eventBus = new AgentEventBus();
    eventBus.on((event) => {
      if (event.type === "tool_start") controller.abort();
    });
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "slow-bash",
              type: "function",
              function: { name: "bash", arguments: { command: "sleep 5" } }
            }
          ]
        }
      }
    ]);

    const result = await runAgent({
      instruction: "slow command",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      eventBus,
      abortSignal: controller.signal,
      commandTimeoutSec: 10
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("cancelled");
  });
});
