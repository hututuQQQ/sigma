import { describe, expect, it } from "vitest";
import type { ModelMessage } from "../packages/agent-protocol/src/index.js";
import { planContext, type ContextPlan } from "../packages/agent-context/src/index.js";

function plan(history: ModelMessage[], contextWindowTokens = 320, outputReserveTokens = 32): ContextPlan {
  return planContext({
    system: [],
    dynamic: [],
    history,
    tools: [],
    contextWindowTokens,
    outputReserveTokens,
    promptCache: false
  });
}

function retainedHistory(result: ContextPlan): ModelMessage[] {
  return result.messages.slice(result.included.length);
}

function expectWireSafe(messages: ModelMessage[]): void {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      expect(message.toolCallId).toBeTruthy();
      expect(pending.has(message.toolCallId ?? "")).toBe(true);
      pending.delete(message.toolCallId ?? "");
      continue;
    }
    expect(pending.size).toBe(0);
    pending = message.role === "assistant"
      ? new Set((message.toolCalls ?? []).map((call) => call.id))
      : new Set();
  }
  expect(pending.size).toBe(0);
}

function toolLoop(index: number, output: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: `call-${index}`, name: "read", arguments: { path: `file-${index}.txt` } }]
    },
    { role: "tool", content: output, toolCallId: `call-${index}` }
  ];
}

describe("ContextPlanner long-running tool history compaction", () => {
  it("textualizes a latest tool-call/result block that cannot fit atomically", () => {
    const hugeOutput = "0123456789abcdef".repeat(65_536);
    const result = plan([
      { role: "user", content: "Inspect the repository and keep working." },
      ...toolLoop(0, hugeOutput)
    ]);
    const history = retainedHistory(result);

    expect(history[0]).toMatchObject({ role: "user", content: "Inspect the repository and keep working." });
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ role: "assistant" });
    expect(history[1].toolCalls).toBeUndefined();
    expect(history[1].content).toContain("history block was omitted");
    expect(history[1].content).toContain("non-executable observation summary");
    expect(history[1].content).toContain("0123456789abcdef");
    expect(JSON.stringify(history)).not.toContain("_contextCompacted");
    expect(result.budget.historyTokens).toBeLessThanOrEqual(288);
    expectWireSafe(history);
  });

  it("preserves receipt status, output preview, and artifact references without call arguments", () => {
    const secretArgument = "do-not-copy-this-executable-argument".repeat(2_000);
    const receipt = [
      "Failed tool receipt ID: large-command",
      'Receipt summary (JSON): {"outcome":{"status":"failed","diagnosticCodes":["process_exit_nonzero"]},"artifactRefs":[{"artifactId":"artifact-output-1","name":"stdout.full"}]}',
      "Output:",
      "preview from the failed command"
    ].join("\n");
    const result = plan([
      { role: "user", content: "Diagnose the command failure." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "large-command", name: "process", arguments: { command: secretArgument } }]
      },
      { role: "tool", content: receipt, toolCallId: "large-command" }
    ], 128_000, 8_000);
    const summary = retainedHistory(result).at(-1);

    expect(summary).toMatchObject({ role: "assistant" });
    expect(summary?.toolCalls).toBeUndefined();
    expect(summary?.content).toContain('"status":"failed"');
    expect(summary?.content).toContain("preview from the failed command");
    expect(summary?.content).toContain("artifact-output-1");
    expect(summary?.content).not.toContain("do-not-copy-this-executable-argument");
    expect(result.latestHistoryBlockTokens).toBeLessThanOrEqual(8_192);
    expectWireSafe(retainedHistory(result));
  });

  it("plans one user followed by 100 tool loops in a small context window", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Complete this long task." }];
    for (let index = 0; index < 100; index += 1) {
      history.push(...toolLoop(index, `result-${index} ${"payload ".repeat(512)}`));
    }

    const result = plan(history, 360, 48);
    const retained = retainedHistory(result);
    expect(retained[0]).toMatchObject({ role: "user", content: "Complete this long task." });
    const latestCallRetained = retained.some((message) =>
      message.toolCalls?.some((call) => call.id === "call-99"));
    expect(latestCallRetained).toBe(
      retained.some((message) => message.role === "tool" && message.toolCallId === "call-99")
    );
    expect(JSON.stringify(retained)).not.toContain("_contextCompacted");
    expect(result.omittedHistoryTurns).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({ authority: "tool", provenance: "lossy conversation compaction" });
    expect(result.summary?.content).toContain("older history blocks");
    expectWireSafe(retained);
  });

  it("proactively compacts old tool results before a large provider window fills", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep working from the durable evidence." }];
    for (let index = 0; index < 96; index += 1) {
      history.push(...toolLoop(index, `observation-${index} ${"large output ".repeat(500)}`));
    }

    const result = plan(history, 128_000, 8_000);
    const retained = retainedHistory(result);

    expect(result.omittedHistoryTurns).toBeGreaterThan(0);
    expect(result.budget.historyTokens).toBeLessThanOrEqual(24_000);
    expect(result.summary).toMatchObject({ authority: "tool", provenance: "lossy conversation compaction" });
    expect(retained.some((message) => message.role === "tool" && message.toolCallId === "call-0")).toBe(false);
    expect(retained.some((message) => message.role === "tool" && message.toolCallId === "call-95")).toBe(true);
    expectWireSafe(retained);
  });

  it("keeps append-only history beyond 24K for prompt-cache providers", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep working from durable evidence." }];
    for (let index = 0; index < 96; index += 1) {
      history.push(...toolLoop(index, `observation-${index} ${"large output ".repeat(500)}`));
    }

    const result = planContext({
      system: [], dynamic: [], history, tools: [],
      contextWindowTokens: 512_000, outputReserveTokens: 8_000, promptCache: true
    });

    expect(result.cacheMode).toBe("prefix_cache");
    expect(result.historyTokenLimit).toBe(504_000);
    expect(result.budget.historyTokens).toBeGreaterThan(24_000);
    expect(result.omittedHistoryTurns).toBe(0);
    expect(result.summary).toBeUndefined();
    expectWireSafe(result.messages);
  });

  it("keeps stable context and durable history before low-to-high priority dynamic suffixes", () => {
    const stable = { id: "stable", authority: "system" as const, provenance: "policy", content: "fixed", tokenCount: 2, priority: 1_000 };
    const durable: ModelMessage[] = [
      { role: "user", content: "request" },
      { role: "assistant", content: "", reasoningContent: "tool reasoning", toolCalls: [{ id: "call", name: "read", arguments: { path: "a" } }] },
      { role: "tool", content: "result", toolCallId: "call" }
    ];
    const dynamic = [
      { id: "deadline", authority: "runtime" as const, provenance: "deadline", content: "finish", tokenCount: 2, priority: 1_000 },
      { id: "repository", authority: "tool" as const, provenance: "repo", content: "changed", tokenCount: 2, priority: 10 }
    ];
    const first = planContext({
      system: [stable], history: durable, dynamic, tools: [],
      contextWindowTokens: 10_000, outputReserveTokens: 100, promptCache: true
    });
    const second = planContext({
      system: [stable], history: durable,
      dynamic: dynamic.map((item) => ({ ...item, content: `${item.content}-again` })), tools: [],
      contextWindowTokens: 10_000, outputReserveTokens: 100, promptCache: true
    });

    const durablePrefixLength = 1 + durable.length;
    expect(second.messages.slice(0, durablePrefixLength)).toEqual(first.messages.slice(0, durablePrefixLength));
    expect(first.messages.slice(durablePrefixLength).map((message) => message.content)).toEqual([
      "[repo]\nchanged",
      "[deadline]\nfinish"
    ]);
    expect(first.dynamicSuffixTokens).toBe(4);
  });

  it("textualizes a latest tool block above the per-block 8K limit even when the provider window fits", () => {
    const content = "export const generated = true;\n".repeat(4_000);
    const result = plan([
      { role: "user", content: "Create the requested artifact." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "large-write",
          name: "write",
          arguments: { path: "src/generated.ts", content }
        }]
      },
      { role: "tool", content: "Wrote src/generated.ts", toolCallId: "large-write" }
    ], 128_000, 8_000);
    const retained = retainedHistory(result);
    expect(retained.flatMap((message) => message.toolCalls ?? [])).toEqual([]);
    expect(retained.at(-1)).toMatchObject({ role: "assistant" });
    expect(retained.at(-1)?.content).toContain("history block was omitted");
    expect(result.latestHistoryBlockTokens).toBeLessThanOrEqual(8_192);
    expect(result.budget.historyTokens).toBeLessThanOrEqual(24_000);
    expectWireSafe(retained);
  });

  it("retains raw blocks as a contiguous newest-first suffix around the latest user", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep the original acceptance criteria." }];
    for (let index = 0; index < 10; index += 1) {
      history.push(...toolLoop(index, `result-${index} ${"details ".repeat(80)}`));
    }

    const retained = retainedHistory(plan(history, 420, 40));
    const retainedCalls = retained.flatMap((message) => message.toolCalls ?? [])
      .map((call) => Number(call.id.slice("call-".length)));
    expect(retained[0].content).toBe("Keep the original acceptance criteria.");
    expect(retainedCalls.at(-1)).toBe(9);
    expect(retainedCalls).toEqual(
      Array.from({ length: 10 - retainedCalls[0] }, (_value, index) => retainedCalls[0] + index)
    );
    expectWireSafe(retained);
  });

  it("summarizes malformed tool history instead of emitting orphaned results", () => {
    const result = plan([
      { role: "user", content: "Investigate safely." },
      { role: "tool", content: "orphaned secret output", toolCallId: "missing-call" },
      {
        role: "assistant",
        content: "incomplete call",
        toolCalls: [{ id: "never-finished", name: "read", arguments: { path: "missing" } }]
      },
      { role: "assistant", content: "Latest observation." }
    ], 1_000, 40);
    const retained = retainedHistory(result);

    expect(retained.some((message) => message.role === "tool")).toBe(false);
    expect(retained.some((message) => message.toolCalls?.length)).toBe(false);
    expect(result.summary).toMatchObject({ authority: "tool" });
    expectWireSafe(retained);
  });
});
