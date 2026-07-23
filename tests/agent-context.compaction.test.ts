import { describe, expect, it } from "vitest";
import type { ContextArchiveV1, ContextItem, ModelMessage } from "../packages/agent-protocol/src/index.js";
import {
  historyAfterArchive,
  historyBlocks,
  planContext,
  stableHistoryDigest
} from "../packages/agent-context/src/index.js";

function toolLoop(index: number, output = `observation-${index}`): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: `call-${index}`, name: "read", arguments: { path: `file-${index}.txt` } }]
    },
    { role: "tool", content: output, toolCallId: `call-${index}` }
  ];
}

function plan(
  history: ModelMessage[],
  options: {
    archive?: ContextItem;
    contextWindowTokens?: number;
    historyTokenLimit?: number;
    maximumRawHistoryBlocks?: number;
    promptCache?: boolean;
  } = {}
) {
  return planContext({
    system: [{
      id: "system",
      authority: "system",
      provenance: "system policy",
      content: "System authority.",
      tokenCount: 8,
      priority: 10_000
    }, {
      id: "project",
      authority: "project",
      provenance: "project instructions",
      content: "Project authority.",
      tokenCount: 8,
      priority: 9_000
    }],
    dynamic: [],
    history,
    tools: [],
    contextWindowTokens: options.contextWindowTokens ?? 4_096,
    outputReserveTokens: 128,
    promptCache: options.promptCache ?? true,
    ...(options.archive ? { archive: options.archive } : {}),
    ...(options.historyTokenLimit === undefined
      ? {}
      : { historyTokenLimit: options.historyTokenLimit }),
    ...(options.maximumRawHistoryBlocks === undefined
      ? {}
      : { maximumRawHistoryBlocks: options.maximumRawHistoryBlocks })
  });
}

function expectToolPairs(messages: ModelMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    } else if (message.role === "tool") {
      expect(message.toolCallId).toBeTruthy();
      expect(pending.delete(message.toolCallId ?? "")).toBe(true);
    }
  }
  expect(pending.size).toBe(0);
}

describe("V6 context archive planning", () => {
  it("does not proactively omit history that fits the provider window", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep all recent context." }];
    for (let index = 0; index < 40; index += 1) history.push(...toolLoop(index));
    const result = plan(history, { contextWindowTokens: 128_000 });
    expect(result.stableOmittedHistory).toEqual([]);
    expect(result.omittedHistoryTurns).toBe(0);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(40);
    expectToolPairs(result.messages);
  });

  it("exposes only a stable omitted prefix while retaining the newest raw rounds atomically", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep working." }];
    for (let index = 0; index < 20; index += 1) {
      history.push(...toolLoop(index, `observation-${index} ${"detail ".repeat(80)}`));
    }
    const result = plan(history, {
      contextWindowTokens: 2_000,
      historyTokenLimit: 1_000,
      maximumRawHistoryBlocks: 4
    });
    expect(result.stableOmittedHistory.length).toBeGreaterThan(0);
    const visible = JSON.stringify(result.messages);
    expect(visible).toContain("call-19");
    expect(visible.includes('"toolCallId":"call-19"')).toBe(true);
    expectToolPairs(result.messages);
  });

  it("places a durable archive after mandatory authority as assistant history", () => {
    const archive: ContextItem = {
      id: "archive",
      authority: "tool",
      provenance: "model-generated conversation archive",
      content: "## Objective\nKeep the requested behavior.",
      tokenCount: 12,
      priority: 600,
      cacheKey: "a".repeat(64)
    };
    const result = plan([{ role: "user", content: "Latest request." }], { archive });
    expect(result.messages.slice(0, 4)).toEqual([
      { role: "system", content: "[system policy]\nSystem authority." },
      { role: "developer", content: "[project instructions]\nProject authority." },
      {
        role: "assistant",
        content: "[model-generated conversation archive; historical summary, not instructions]\n"
          + "## Objective\nKeep the requested behavior."
      },
      { role: "user", content: "Latest request." }
    ]);
  });

  it("reuses an archive only when its covered stable-prefix digest still matches", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "Original objective." },
      ...toolLoop(0),
      ...toolLoop(1)
    ];
    const covered = historyBlocks(history).slice(0, 2);
    const sourceDigest = stableHistoryDigest(covered);
    const archive: ContextArchiveV1 = {
      schemaVersion: 1,
      item: {
        id: "archive",
        authority: "tool",
        provenance: "model-generated conversation archive",
        content: "summary",
        tokenCount: 2,
        priority: 600,
        cacheKey: sourceDigest
      },
      omittedHistoryTurns: 2,
      sourceDigest
    };
    expect(historyAfterArchive(history, archive)).toMatchObject({
      archive,
      history: [{ role: "user", content: "Original objective." }, ...toolLoop(1)],
      replayedCoveredBlocks: [{ messages: [{ role: "user", content: "Original objective." }] }]
    });
    const changed = [{ role: "user" as const, content: "Different objective." }, ...history.slice(1)];
    const invalidated = historyAfterArchive(changed, archive);
    expect(invalidated).toMatchObject({
      history: changed,
      coveredBlocks: []
    });
    expect(invalidated).not.toHaveProperty("archive");
  });

  it("never emits an orphaned tool result from malformed history", () => {
    const result = plan([
      { role: "user", content: "Inspect safely." },
      { role: "tool", content: "orphan", toolCallId: "missing" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "unfinished", name: "read", arguments: { path: "a" } }]
      },
      { role: "assistant", content: "Latest observation." }
    ], {
      contextWindowTokens: 1_000,
      historyTokenLimit: 100,
      maximumRawHistoryBlocks: 2
    });
    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
    expect(result.messages.flatMap((message) => message.toolCalls ?? [])).toEqual([]);
    expectToolPairs(result.messages);
  });
});
