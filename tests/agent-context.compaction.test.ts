import { describe, expect, it } from "vitest";
import type { ModelMessage } from "../packages/agent-protocol/src/index.js";
import {
  planContext,
  summarizeHistory,
  summarizeStableHistory,
  type ContextPlan
} from "../packages/agent-context/src/index.js";
import { historySummaries } from "../packages/agent-context/src/history-planning.js";

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

function cachedPlan(toolLoops: number): ContextPlan {
  const history: ModelMessage[] = [{ role: "user", content: "Keep working from durable evidence." }];
  for (let index = 0; index < toolLoops; index += 1) {
    history.push(...toolLoop(index, `observation-${index} ${"details ".repeat(32)}`));
  }
  return planContext({
    system: [], dynamic: [], history, tools: [],
    contextWindowTokens: 512_000, outputReserveTokens: 8_000, promptCache: true
  });
}

function uncachedPlan(toolLoops: number): ContextPlan {
  const history: ModelMessage[] = [{ role: "user", content: "Keep working from durable evidence." }];
  for (let index = 0; index < toolLoops; index += 1) {
    history.push(...toolLoop(index, `observation-${index} ${"details ".repeat(32)}`));
  }
  return planContext({
    system: [], dynamic: [], history, tools: [],
    contextWindowTokens: 512_000, outputReserveTokens: 8_000, promptCache: false
  });
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

  it("prioritizes semantic receipt output over invocation markers in tight summaries", () => {
    const receipt = [
      "Failed tool receipt ID: compact-command",
      'Receipt summary (JSON): {"outcome":{"status":"failed","diagnosticCodes":{"entries":["process_exit_nonzero"]}},"changedPaths":{"entries":["modified:src/a.ts"]},"evidence":{"entries":[]}}',
      "Output:",
      "critical compiler fact"
    ].join("\n");
    const summary = summarizeHistory([[
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "compact-command",
          name: "shell",
          arguments: { command: "secret executable arguments must stay out" }
        }]
      },
      { role: "tool", toolCallId: "compact-command", content: receipt }
    ]], 128);

    expect(summary?.content).toContain("status=failed");
    expect(summary?.content).toContain("critical compiler fact");
    expect(summary?.content).not.toContain("secret executable arguments");
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
    expect(result.summary).toMatchObject({
      authority: "tool", provenance: "lossy conversation compaction archive"
    });
    expect(result.summary?.content).toContain("archived history");
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
    expect(result.summary).toMatchObject({
      authority: "tool", provenance: "lossy conversation compaction archive"
    });
    expect(retained.some((message) => message.role === "tool" && message.toolCallId === "call-0")).toBe(false);
    expect(retained.some((message) => message.role === "tool" && message.toolCallId === "call-95")).toBe(true);
    expectWireSafe(retained);
  });

  it("bounds and summarizes raw history even for prompt-cache providers", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep working from durable evidence." }];
    for (let index = 0; index < 96; index += 1) {
      history.push(...toolLoop(index, `observation-${index} ${"large output ".repeat(500)}`));
    }

    const result = planContext({
      system: [], dynamic: [], history, tools: [],
      contextWindowTokens: 512_000, outputReserveTokens: 8_000, promptCache: true
    });

    expect(result.cacheMode).toBe("prefix_cache");
    expect(result.historyTokenLimit).toBe(96_000);
    expect(result.budget.historyTokens).toBeGreaterThan(20_000);
    expect(result.budget.historyTokens).toBeLessThanOrEqual(112_000);
    expect(result.omittedHistoryTurns).toBeGreaterThan(0);
    expect(result.summary?.tokenCount).toBeLessThanOrEqual(16_000);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(11);
    expectWireSafe(result.messages);
  });

  it("keeps the completed cache archive immutable within an epoch and append-only across epochs", () => {
    // The user block occupies one of the 12 raw slots, leaving 11 raw tool
    // blocks. Nineteen loops therefore produce the first complete 8-block
    // archive epoch; loops 20-26 only grow the separate recent delta.
    const firstEpoch = cachedPlan(19);
    const withinEpoch = cachedPlan(26);
    const secondEpoch = cachedPlan(27);

    expect(firstEpoch.omittedHistoryTurns).toBe(8);
    expect(withinEpoch.omittedHistoryTurns).toBe(15);
    expect(secondEpoch.omittedHistoryTurns).toBe(16);
    expect(firstEpoch.summary).toBeDefined();
    expect(withinEpoch.summary).toMatchObject({
      id: firstEpoch.summary?.id,
      content: firstEpoch.summary?.content
    });
    expect(secondEpoch.summary?.id).not.toBe(firstEpoch.summary?.id);
    expect(secondEpoch.summary?.content.startsWith(`${firstEpoch.summary?.content}\n`)).toBe(true);
    const archivePrefix = "[lossy conversation compaction archive]\n";
    const firstVisibleArchive = firstEpoch.messages.find((message) => message.content.startsWith(archivePrefix));
    const withinVisibleArchive = withinEpoch.messages.find((message) => message.content.startsWith(archivePrefix));
    const secondVisibleArchive = secondEpoch.messages.find((message) => message.content.startsWith(archivePrefix));
    expect(withinVisibleArchive?.content).toBe(firstVisibleArchive?.content);
    expect(secondVisibleArchive?.content.startsWith(`${firstVisibleArchive?.content}\n`)).toBe(true);
    expect(firstEpoch.messages.filter((message) => message.role === "tool")).toHaveLength(11);
    expect(withinEpoch.messages.filter((message) => message.role === "tool")).toHaveLength(11);
    expect(secondEpoch.messages.filter((message) => message.role === "tool")).toHaveLength(11);
    for (const result of [firstEpoch, withinEpoch, secondEpoch]) {
      const summaryTokens = result.included
        .filter((item) => item.provenance.startsWith("lossy conversation compaction"))
        .reduce((total, item) => total + item.tokenCount, 0);
      expect(summaryTokens).toBeLessThanOrEqual(16_000);
      expectWireSafe(result.messages);
    }
  });

  it("keeps an immutable epoch archive and bounded recent delta without provider caching", () => {
    const firstEpoch = uncachedPlan(19);
    const withinEpoch = uncachedPlan(26);
    const secondEpoch = uncachedPlan(27);

    expect(firstEpoch.cacheMode).toBe("proactive_window");
    expect(firstEpoch.omittedHistoryTurns).toBe(8);
    expect(withinEpoch.omittedHistoryTurns).toBe(15);
    expect(secondEpoch.omittedHistoryTurns).toBe(16);
    expect(withinEpoch.summary).toMatchObject({
      id: firstEpoch.summary?.id,
      content: firstEpoch.summary?.content
    });
    expect(secondEpoch.summary?.content.startsWith(`${firstEpoch.summary?.content}\n`)).toBe(true);
    for (const result of [firstEpoch, withinEpoch, secondEpoch]) {
      const summaries = result.included.filter((item) =>
        item.provenance.startsWith("lossy conversation compaction"));
      const recentDelta = summaries.find((item) =>
        item.provenance === "lossy conversation compaction");
      expect(summaries.reduce((total, item) => total + item.tokenCount, 0)).toBeLessThanOrEqual(16_000);
      expect(recentDelta?.tokenCount ?? 0).toBeLessThanOrEqual(2_048);
      expectWireSafe(result.messages);
    }
  });

  it("preserves semantic receipt facts across more than 250 immutable archived blocks", () => {
    const blocks = Array.from({ length: 256 }, (_unused, index): ModelMessage[] => [
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: `archive-${index}`,
          name: "read",
          arguments: { path: `volatile-argument-${index}.txt` }
        }]
      },
      {
        role: "tool",
        toolCallId: `archive-${index}`,
        content: [
          `Successful tool receipt ID: archive-${index}`,
          'Receipt summary (JSON): {"outcome":{"status":"succeeded","diagnosticCodes":{"entries":[]}},"changedPaths":{"entries":[]},"evidence":{"entries":[]}}',
          "Output:",
          `durable-fact-${index}`
        ].join("\n")
      }
    ]);
    const first = summarizeStableHistory(blocks.slice(0, 248), 16_000);
    const extended = summarizeStableHistory(blocks, 16_000);

    expect(first).toBeDefined();
    expect(extended?.content.startsWith(`${first?.content}\n`)).toBe(true);
    expect(extended?.content).toContain("durable-fact-0");
    expect(extended?.content).toContain("durable-fact-255");
    expect(extended?.content).not.toContain("volatile-argument-");
    expect(extended?.tokenCount).toBeLessThanOrEqual(16_000);
  });

  it("reserves stable epoch space for receipt output head and tail plus evidence", () => {
    const blocks = Array.from({ length: 256 }, (_unused, index): ModelMessage[] => [{
      role: "tool",
      toolCallId: `archive-${index}`,
      content: [
        `Successful tool receipt ID: archive-${index}`,
        `Receipt summary (JSON): {"outcome":{"status":"succeeded","diagnosticCodes":{"entries":["ok-${index}"]}},"changedPaths":{"entries":["src/file-${index}.ts"]},"evidence":{"entries":["proof-${index}"]},"artifactRefs":{"entries":["artifact-${index}"]}}`,
        "Output:",
        `head-${index} ${"middle ".repeat(200)} tail-${index}`
      ].join("\n")
    }]);
    const first = summarizeStableHistory(blocks.slice(0, 248), 16_000);
    const extended = summarizeStableHistory(blocks, 16_000);

    expect(extended?.content.startsWith(`${first?.content}\n`)).toBe(true);
    expect(extended?.content).toContain("head-255");
    expect(extended?.content).toContain("tail-255");
    expect(extended?.content).toContain("proof-255");
    expect(extended?.content).toContain("artifact-255");
    expect(extended?.tokenCount).toBeLessThanOrEqual(16_000);
  });

  it("keeps the newest complete epoch in the bounded delta after the stable archive fills", () => {
    const blocks = Array.from({ length: 64 }, (_unused, index): ModelMessage[] => [{
      role: "tool",
      toolCallId: `overflow-${index}`,
      content: `newest-fact-${index} ${"payload ".repeat(80)}`
    }]);
    const result = historySummaries(blocks, 320);

    expect(result.summary).toBeDefined();
    expect(result.summaryDelta).toBeDefined();
    expect(result.summaryDelta?.content).toContain("newest-fact-63");
    expect(result.summary?.content).not.toContain("newest-fact-63");
    expect((result.summary?.tokenCount ?? 0) + (result.summaryDelta?.tokenCount ?? 0))
      .toBeLessThanOrEqual(320);
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

  it("applies stage history ceilings without truncating the latest user authority", () => {
    const latestAuthority = `Preserve these exact requirements: ${"authority-bearing detail ".repeat(160)}`;
    const history: ModelMessage[] = [{ role: "user", content: "Earlier task framing." }];
    for (let index = 0; index < 10; index += 1) {
      history.push(...toolLoop(index, `old observation ${index} ${"detail ".repeat(64)}`));
    }
    history.push({ role: "user", content: latestAuthority });

    const result = planContext({
      system: [], dynamic: [], history, tools: [],
      contextWindowTokens: 32_000, outputReserveTokens: 1_000, promptCache: true,
      historyTokenLimit: 32,
      rawHistoryBlockTokenLimit: 16,
      historySummaryTokenLimit: 64,
      maximumRawHistoryBlocks: 2
    });

    expect(result.historyTokenLimit).toBe(32);
    expect(result.messages.some((message) => message.role === "user"
      && message.content === latestAuthority)).toBe(true);
    expect(result.budget.historyTokens).toBeGreaterThan(32);
    expect(result.included.filter((item) => item.provenance.startsWith("lossy conversation compaction"))
      .reduce((total, item) => total + item.tokenCount, 0)).toBeLessThanOrEqual(64);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(0);
  });
});
