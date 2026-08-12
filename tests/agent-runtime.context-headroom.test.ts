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
  contextCapacityFailure,
  providerSizedPlan
} from "../packages/agent-runtime/src/effect-helpers.js";

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

describe("provider context headroom", () => {
  it("omits a stable replayable prefix before history reaches the full provider window", async () => {
    const gateway = new CountingGateway();
    const history: ModelMessage[] = [
      { role: "user", content: "Keep working from the durable task." },
      ...Array.from({ length: 9 }, (_, index) => ({
        role: "assistant" as const,
        content: `${index}:${"x".repeat(340)}`
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

    expect(plan.budget.contextWindowTokens).toBeLessThanOrEqual(700);
    expect(plan.stableOmittedHistory.length).toBeGreaterThan(0);
    expect(await gateway.countTokens(plan.messages)).toBeLessThanOrEqual(600);
    expect(plan.messages.at(-1)?.content).toBe(history.at(-1)?.content);
  });

  it("rejects mandatory context that the approximate-token route cannot admit", async () => {
    const gateway = new CountingGateway();
    const content = "x".repeat(3_300);
    expect(messageTokens({ role: "user", content })).toBeGreaterThan(800);
    expect(messageTokens({ role: "user", content })).toBeLessThanOrEqual(900);

    await expect(providerSizedPlan(gateway, {
      system: [],
      history: [{ role: "user", content }],
      dynamic: [],
      tools: [],
      outputReserveTokens: 100
    })).rejects.toMatchObject({ code: "context_overflow" });
  });

  it("uses the full provider window when the provider supplies exact counts", async () => {
    const gateway = new CountingGateway("provider");
    const content = "x".repeat(3_300);

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

  it("recovers only all-context route rejections", () => {
    expect(contextCapacityFailure({
      code: "model_route_unavailable",
      routeId: "default",
      rejected: [{ modelSpecId: "provider/model", reason: "context", detail: "1001 tokens exceed candidate limits" }]
    })).toEqual({
      source: "router",
      routeId: "default",
      rejections: [{ modelSpecId: "provider/model", detail: "1001 tokens exceed candidate limits" }]
    });
    expect(contextCapacityFailure({
      code: "model_route_unavailable",
      rejected: [{ modelSpecId: "provider/model", reason: "capability", detail: "tools required" }]
    })).toBeUndefined();
    expect(contextCapacityFailure({
      code: "model_route_unavailable",
      rejected: [
        { modelSpecId: "provider/a", reason: "context", detail: "too large" },
        { modelSpecId: "provider/b", reason: "budget", detail: "too expensive" }
      ]
    })).toBeUndefined();
  });
});
