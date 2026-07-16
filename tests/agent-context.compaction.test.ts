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
    outputReserveTokens
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
  it("keeps the latest tool-call/result block atomic while bounding a 1 MiB result", () => {
    const hugeOutput = "0123456789abcdef".repeat(65_536);
    const result = plan([
      { role: "user", content: "Inspect the repository and keep working." },
      ...toolLoop(0, hugeOutput)
    ]);
    const history = retainedHistory(result);

    expect(history[0]).toMatchObject({ role: "user", content: "Inspect the repository and keep working." });
    expect(history[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "call-0" }] });
    expect(history[2]).toMatchObject({ role: "tool", toolCallId: "call-0" });
    expect(history[2].content.length).toBeLessThan(hugeOutput.length / 100);
    expect(history[2].content).toContain("context compacted");
    expect(result.budget.historyTokens).toBeLessThanOrEqual(288);
    expectWireSafe(history);
  });

  it("plans one user followed by 100 tool loops in a small context window", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Complete this long task." }];
    for (let index = 0; index < 100; index += 1) {
      history.push(...toolLoop(index, `result-${index} ${"payload ".repeat(512)}`));
    }

    const result = plan(history, 360, 48);
    const retained = retainedHistory(result);
    expect(retained[0]).toMatchObject({ role: "user", content: "Complete this long task." });
    expect(retained.some((message) => message.toolCalls?.some((call) => call.id === "call-99"))).toBe(true);
    expect(retained.some((message) => message.role === "tool" && message.toolCallId === "call-99")).toBe(true);
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
