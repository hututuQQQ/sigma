import { describe, expect, it } from "vitest";
import type { ModelMessage } from "../packages/agent-protocol/src/index.js";
import {
  blockTokens,
  historyBlocks
} from "../packages/agent-context/src/index.js";
import {
  archiveCoverageTarget
} from "../packages/agent-runtime/src/context-archive-refresh.js";

function toolLoop(index: number): ModelMessage[] {
  return [{
    role: "assistant",
    content: "",
    toolCalls: [{ id: `call-${index}`, name: "read", arguments: { path: `file-${index}.ts` } }]
  }, {
    role: "tool",
    toolCallId: `call-${index}`,
    content: `observation-${index} ${"detail ".repeat(120)}`
  }];
}

describe("context archive refresh hysteresis", () => {
  it("extends a minimal omission while preserving a recent raw tail", () => {
    const history: ModelMessage[] = [{ role: "user", content: "Keep working." }];
    for (let index = 0; index < 14; index += 1) history.push(...toolLoop(index));
    const blocks = historyBlocks(history);
    const historyTokenLimit = blocks
      .reduce((total, block) => total + blockTokens(block.messages), 0);
    const minimumCoverage = 2;

    const coverage = archiveCoverageTarget(
      blocks,
      minimumCoverage,
      historyTokenLimit
    );

    expect(coverage).toBeGreaterThan(minimumCoverage);
    expect(blocks.length - coverage).toBeGreaterThanOrEqual(4);
    const minimumTailTokens = blocks.slice(minimumCoverage)
      .reduce((total, block) => total + blockTokens(block.messages), 0);
    const targetedTailTokens = blocks.slice(coverage)
      .reduce((total, block) => total + blockTokens(block.messages), 0);
    expect(targetedTailTokens).toBeLessThan(minimumTailTokens);
  });

  it("does not extend coverage when the retained tail already has headroom", () => {
    const blocks = historyBlocks([
      { role: "user", content: "Keep working." },
      ...toolLoop(0),
      ...toolLoop(1),
      ...toolLoop(2),
      ...toolLoop(3),
      ...toolLoop(4)
    ]);

    expect(archiveCoverageTarget(blocks, 1, 1_000_000)).toBe(1);
  });
});
