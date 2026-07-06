import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { runAgent } from "../packages/agent-core/src/index.js";

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
      "Previous agent conversation compacted by harness."
    );
    expect(thirdRequestMessages[3].role).toBe("assistant");
  });
});
