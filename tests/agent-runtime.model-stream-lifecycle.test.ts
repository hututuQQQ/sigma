import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";

class IncompleteStreamGateway implements ModelGateway {
  readonly provider = "lifecycle-provider";
  readonly model = "lifecycle-model";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("not used");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "reasoning", delta: "partial reasoning is not a final response" };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
  }
}

describe("runtime model stream lifecycle", () => {
  it("emits model and run failure terminals when a model stream has no final response", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-incomplete-model-stream-"));
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway: new IncompleteStreamGateway(),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: new EffectToolRegistry(),
      permissionMode: "auto",
      runDeadlineMs: 5_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });

    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "inspect the generic lifecycle",
      mode: "analyze"
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "recoverable_failure",
      code: "model_stream_incomplete"
    });

    const events = [];
    for await (const event of runtime.sessionEvents(session.sessionId)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "model.reasoning_delta",
      "usage.recorded",
      "model.failed",
      "run.failed"
    ]));
    const modelFailure = events.find((event) => event.type === "model.failed");
    expect(modelFailure?.payload).toMatchObject({
      code: "model_stream_incomplete",
      diagnostics: {
        provider: "lifecycle-provider",
        model: "lifecycle-model",
        category: "protocol",
        doneReceived: false,
        lastEventType: "reasoning",
        hasContent: false,
        hasReasoning: true,
        hasToolCall: false
      }
    });
    expect(events.at(-1)?.type).toBe("run.failed");
  });
});
