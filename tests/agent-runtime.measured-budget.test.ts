import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

class UnderestimatedGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "measured-usage";
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

async function storedEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("provider-measured model budget settlement", () => {
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
});
