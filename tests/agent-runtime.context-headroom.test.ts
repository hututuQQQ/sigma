import { describe, expect, it } from "vitest";
import {
  approximateTokens,
  blockTokens,
  messageTokens
} from "../packages/agent-context/src/index.js";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import {
  modelImageInputTokenEstimate,
  modelMessagesWithoutImagePayloads
} from "../packages/agent-protocol/src/index.js";
import { providerSizedPlan } from "../packages/agent-runtime/src/effect-helpers.js";

class CountingGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "context-headroom";
  readonly capabilities: ModelCapabilities;

  constructor(tokenizer: ModelCapabilities["tokenizer"] = "approximate") {
    this.capabilities = {
      contextWindowTokens: 1_000,
      maxOutputTokens: 100,
      tools: true,
      parallelTools: false,
      reasoning: false,
      structuredOutput: false,
      promptCache: false,
      tokenizer
    };
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("This test only plans context.");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("This test only plans context."));
  }

  async countTokens(
    messages: ModelMessage[],
    tools: ModelToolDefinition[] = []
  ): Promise<number> {
    return blockTokens(messages) + tools.reduce(
      (total, tool) => total + approximateTokens(JSON.stringify(tool)) + 8,
      0
    );
  }
}

class SerializedCountingGateway extends CountingGateway {
  override async countTokens(
    messages: ModelMessage[],
    tools: ModelToolDefinition[] = []
  ): Promise<number> {
    return approximateTokens(JSON.stringify({
      messages: modelMessagesWithoutImagePayloads(messages),
      tools
    })) + modelImageInputTokenEstimate(messages);
  }
}

class OpaqueOverheadGateway extends CountingGateway {
  override async countTokens(
    messages: ModelMessage[],
    tools: ModelToolDefinition[] = []
  ): Promise<number> {
    const visible = await super.countTokens(messages, tools);
    const opaqueReplayItems = messages.filter((message) =>
      message.providerState !== undefined).length;
    return visible + opaqueReplayItems * 250;
  }
}

describe("provider context headroom", () => {
  it("drops optional oldest blocks when provider measurement disproves the local estimate", async () => {
    const gateway = new OpaqueOverheadGateway("provider");
    const history: ModelMessage[] = [
      { role: "user", content: "Preserve this instruction." },
      ...Array.from({ length: 6 }, (_, index): ModelMessage[] => {
        const callId = `opaque-call-${index}`;
        return [{
          role: "assistant",
          content: "",
          reasoningContent: "Inspect one independent part.",
          toolCalls: [{ id: callId, name: "read", arguments: { path: `${index}.txt` } }],
          providerState: {
            provider: "fake",
            version: 1,
            data: { replay: index }
          }
        }, {
          role: "tool",
          content: `${index}: inspected one independent part of the repository`,
          toolCallId: callId
        }];
      }).flat()
    ];

    const plan = await providerSizedPlan(gateway, {
      system: [],
      history,
      dynamic: [],
      tools: [],
      outputReserveTokens: 100
    });

    expect(await gateway.countTokens(plan.messages)).toBeLessThanOrEqual(800);
    expect(plan.stableOmittedHistory.length).toBeGreaterThan(0);
    expect(plan.messages.at(-1)?.content).toBe(history.at(-1)?.content);
  });

  it("recovers when provider-native replay state is much larger than neutral history", async () => {
    const gateway = new SerializedCountingGateway("provider");
    const history: ModelMessage[] = [
      { role: "user", content: "Keep the latest instruction and continue safely." }
    ];
    for (let index = 0; index < 8; index += 1) {
      const callId = `call-${index}`;
      history.push({
        role: "assistant",
        content: "",
        reasoningContent: "Inspect the current state.",
        toolCalls: [{ id: callId, name: "read", arguments: { path: `file-${index}.txt` } }],
        providerState: {
          provider: "fake",
          version: 1,
          data: {
            api: "responses",
            model: "context-headroom",
            content: [{
              type: "thinking",
              thinking: "Inspect the current state.",
              thinkingSignature: `${index}:${"x".repeat(1_800)}`
            }]
          }
        }
      }, {
        role: "tool",
        content: `observation-${index}`,
        toolCallId: callId
      });
    }

    const plan = await providerSizedPlan(gateway, {
      system: [],
      history,
      dynamic: [],
      tools: [],
      outputReserveTokens: 100
    });

    expect(await gateway.countTokens(plan.messages)).toBeLessThanOrEqual(800);
    expect(plan.stableOmittedHistory.length).toBeGreaterThan(0);
    expect(plan.messages.some((message) => message.role === "user"
      && message.content.includes("latest instruction"))).toBe(true);
  });

  it("omits a stable replayable prefix before history reaches the full provider window", async () => {
    const gateway = new CountingGateway();
    const history: ModelMessage[] = [
      { role: "user", content: "Keep working from the durable task." },
      ...Array.from({ length: 9 }, (_, index) => ({
        role: "assistant" as const,
        content: `${index}:${"x".repeat(325)}`
      }))
    ];
    const rawTokens = blockTokens(history);
    expect(rawTokens).toBeGreaterThan(800);
    expect(rawTokens).toBeLessThanOrEqual(900);

    const plan = await providerSizedPlan(gateway, {
      system: [],
      history,
      dynamic: [],
      tools: [],
      outputReserveTokens: 100
    });

    expect(plan.budget.contextWindowTokens).toBeLessThanOrEqual(900);
    expect(plan.stableOmittedHistory.length).toBeGreaterThan(0);
    expect(await gateway.countTokens(plan.messages)).toBeLessThanOrEqual(800);
    expect(plan.messages.at(-1)?.content).toBe(history.at(-1)?.content);
  });

  it("falls back to the full window instead of truncating the newest user instruction", async () => {
    const gateway = new CountingGateway("provider");
    const content = "x".repeat(3_300);
    expect(messageTokens({ role: "user", content })).toBeGreaterThan(800);
    expect(messageTokens({ role: "user", content })).toBeLessThanOrEqual(900);

    const plan = await providerSizedPlan(gateway, {
      system: [],
      history: [{ role: "user", content }],
      dynamic: [],
      tools: [],
      outputReserveTokens: 100
    });

    expect(plan.budget.contextWindowTokens).toBe(1_000);
    expect(plan.stableOmittedHistory).toEqual([]);
    expect(plan.messages).toEqual([{ role: "user", content }]);
  });

  it("uses the same approximate-token reservation margin as route selection", async () => {
    const gateway = new CountingGateway("approximate");
    const history: ModelMessage[] = [
      { role: "user", content: "Keep the newest instruction." },
      ...Array.from({ length: 7 }, (_, index) => ({
        role: "assistant" as const,
        content: `${index}:${"x".repeat(300)}`
      }))
    ];

    const plan = await providerSizedPlan(gateway, {
      system: [],
      history,
      dynamic: [],
      tools: [],
      outputReserveTokens: 100
    });
    const inputTokens = await gateway.countTokens(plan.messages);

    expect(Math.ceil(inputTokens * 1.5) + 100).toBeLessThanOrEqual(1_000);
    expect(plan.stableOmittedHistory.length).toBeGreaterThan(0);
    expect(plan.messages.at(-1)?.content).toBe(history.at(-1)?.content);
  });

  it("also bounds provider planning by the remaining aggregate input ledger", async () => {
    const gateway = new CountingGateway("approximate");
    const history: ModelMessage[] = [
      { role: "user", content: "Keep the newest instruction." },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant" as const,
        content: `${index}:${"x".repeat(300)}`
      }))
    ];
    const plan = await providerSizedPlan(gateway, {
      system: [],
      history,
      dynamic: [],
      tools: [],
      outputReserveTokens: 100,
      maxInputTokens: 350
    });

    expect(await gateway.countTokens(plan.messages)).toBeLessThanOrEqual(350);
    expect(plan.stableOmittedHistory.length).toBeGreaterThan(0);
    await expect(providerSizedPlan(gateway, {
      system: [],
      history: [{ role: "user", content: "required" }],
      dynamic: [],
      tools: [],
      outputReserveTokens: 100,
      maxInputTokens: 0
    })).rejects.toMatchObject({ code: "context_overflow" });
  });
});
