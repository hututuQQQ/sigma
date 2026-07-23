import { describe, expect, it } from "vitest";
import type {
  AgentEventType,
  ContextItem,
  ModelCapabilities,
  ModelFinishReason,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall
} from "../packages/agent-protocol/src/index.js";
import type { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  deterministicArchiveFallback,
  ModelSummarizer,
  type ModelSummaryInput
} from "../packages/agent-runtime/src/model-summarizer.js";
import type {
  RuntimeEventEmitter
} from "../packages/agent-runtime/src/runtime-event-emitter.js";
import type { RuntimeOptions } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const HEADINGS = [
  "Objective",
  "Constraints and decisions",
  "Completed",
  "In progress",
  "Blocked",
  "Key errors and tool facts",
  "Next steps",
  "Relevant files"
] as const;

function summaryContent(prefix = "recorded"): string {
  return HEADINGS.map((heading) => `## ${heading}\n${prefix} ${heading}.`).join("\n\n");
}

class SummaryGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "summary";
  readonly requests: ModelRequest[] = [];
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    tools: true,
    parallelTools: false,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  constructor(
    private readonly content: string,
    private readonly finishReason: ModelFinishReason = "stop",
    private readonly toolCalls?: ModelToolCall[],
    private readonly failArchiveTokenCount = false
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: this.content,
        ...(this.toolCalls ? { toolCalls: this.toolCalls } : {})
      },
      finishReason: this.finishReason,
      usage: {
        inputTokens: 50,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 0,
        latencyMs: 1,
        retryAttempt: 0
      }
    };
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("The summarizer must use the non-streaming, no-tool route."));
  }

  async countTokens(messages: ModelMessage[]): Promise<number> {
    if (this.failArchiveTokenCount && messages.length === 1
      && messages[0]?.role === "assistant") {
      throw new Error("tokenizer unavailable after summarization");
    }
    return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
  }
}

function summaryInput(previous?: ContextItem): ModelSummaryInput {
  return {
    sourceDigest: "a".repeat(64),
    omittedHistoryTurns: 2,
    stableHistory: [
      [{ role: "user", content: "Implement the general behavior." }],
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read", name: "read", arguments: { path: "src/index.ts" } }]
        },
        { role: "tool", content: "Successful tool receipt.", toolCallId: "read" }
      ]
    ],
    newHistory: [[{ role: "user", content: "Implement the general behavior." }]],
    ...(previous ? { previous } : {})
  };
}

function harness(gateway: SummaryGateway) {
  const session = runtimeSessionFixture({ services: { gateway } });
  const calls: string[] = [];
  const usage: unknown[] = [];
  const budgets = {
    async reserve() {
      calls.push("reserve");
      return "summary-reservation";
    },
    async commitMeasured() {
      calls.push("commit");
      return { overReservation: {}, overLimit: {}, overruns: [] };
    }
  } as unknown as BudgetController;
  const emit: RuntimeEventEmitter = async (_session, type: AgentEventType, _authority, payload) => {
    if (type === "usage.recorded") usage.push(payload);
    return {} as never;
  };
  const runtime = {
    gateway,
    gatewayForRole(role: string) {
      calls.push(`route:${role}`);
      return gateway;
    }
  } as unknown as RuntimeOptions;
  return {
    session,
    calls,
    usage,
    summarizer: new ModelSummarizer({ runtime, budgets, emit })
  };
}

describe("ModelSummarizer", () => {
  it("uses the summarizer role with no tools and records measured usage", async () => {
    const gateway = new SummaryGateway(summaryContent());
    const test = harness(gateway);
    const archive = await test.summarizer.summarize(
      test.session,
      summaryInput(),
      new AbortController().signal
    );
    expect(archive).toMatchObject({
      authority: "tool",
      provenance: "model-generated conversation archive",
      cacheKey: "a".repeat(64)
    });
    expect(HEADINGS.every((heading) => archive!.content.includes(`## ${heading}`))).toBe(true);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({ tools: [], toolChoice: "none", temperature: 0 });
    expect(test.calls).toEqual(["route:summarizer", "reserve", "commit"]);
    expect(test.usage).toHaveLength(1);
    expect(test.usage[0]).toMatchObject({ role: "summarizer" });
  });

  it("rejects malformed output after one attempt so the caller can fall back", async () => {
    const gateway = new SummaryGateway("A free-form answer without the required sections.");
    const test = harness(gateway);
    await expect(test.summarizer.summarize(
      test.session,
      summaryInput(),
      new AbortController().signal
    )).resolves.toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
    expect(test.usage).toHaveLength(1);

    const fallback = await deterministicArchiveFallback(gateway, summaryInput());
    expect(fallback).toMatchObject({
      provenance: "deterministic conversation archive fallback",
      cacheKey: "a".repeat(64)
    });
  });

  it.each([
    {
      label: "a truncated response",
      gateway: () => new SummaryGateway(summaryContent(), "length")
    },
    {
      label: "a tool-bearing response",
      gateway: () => new SummaryGateway(summaryContent(), "tool_calls", [{
        id: "unexpected",
        name: "read",
        arguments: { path: "README.md" }
      }])
    }
  ])("rejects $label after recording its single measured attempt", async ({ gateway: makeGateway }) => {
    const gateway = makeGateway();
    const test = harness(gateway);
    await expect(test.summarizer.summarize(
      test.session,
      summaryInput(),
      new AbortController().signal
    )).resolves.toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
    expect(test.calls.filter((call) => call === "commit")).toHaveLength(1);
    expect(test.usage).toHaveLength(1);
  });

  it("uses a deterministic token estimate if archive tokenization fails after settlement", async () => {
    const gateway = new SummaryGateway(summaryContent(), "stop", undefined, true);
    const test = harness(gateway);
    const archive = await test.summarizer.summarize(
      test.session,
      summaryInput(),
      new AbortController().signal
    );
    expect(archive?.tokenCount).toBe(Math.ceil(summaryContent().length / 4));
    expect(test.calls.filter((call) => call === "commit")).toHaveLength(1);
    expect(test.usage).toHaveLength(1);
  });

  it("feeds the previous assistant archive only as historical data during an increment", async () => {
    const gateway = new SummaryGateway(summaryContent("updated"));
    const test = harness(gateway);
    const previous: ContextItem = {
      id: "previous",
      authority: "tool",
      provenance: "model-generated conversation archive",
      content: summaryContent("previous"),
      tokenCount: 100,
      priority: 600,
      cacheKey: "b".repeat(64)
    };
    await test.summarizer.summarize(
      test.session,
      summaryInput(previous),
      new AbortController().signal
    );
    const request = gateway.requests[0]!;
    expect(request.messages[0]).toMatchObject({ role: "system" });
    expect(request.messages[1]).toMatchObject({ role: "user" });
    expect(request.messages[1].content).toContain("previousArchive");
    expect(request.messages).toHaveLength(2);
  });
});
