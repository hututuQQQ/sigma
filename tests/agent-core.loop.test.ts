import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { AgentEventBus, runAgent } from "../packages/agent-core/src/index.js";

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

  it("compacts old messages without leaving an orphan tool message at the retained tail", async () => {
    const dir = await tempWorkspace();
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
      compactionSummaryChars: 500
    });

    expect(result.status).toBe("completed");
    const thirdRequestMessages = model.requests[2].messages;
    expect(thirdRequestMessages[0].role).toBe("system");
    expect(thirdRequestMessages[1]).toMatchObject({ role: "user", content: "make lots of output" });
    expect(thirdRequestMessages[2].role).toBe("user");
    expect((thirdRequestMessages[2] as { content?: string }).content).toContain(
      "Previous agent conversation compacted by the run controller."
    );
    expect(thirdRequestMessages[3].role).toBe("assistant");
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
