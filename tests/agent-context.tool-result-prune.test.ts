import { describe, expect, it } from "vitest";
import type { ModelMessage } from "../packages/agent-protocol/src/index.js";
import {
  projectToolResultHistory,
  proposeToolResultPrune
} from "../packages/agent-context/src/history-planning.js";

function history(blocks: number): ModelMessage[] {
  return Array.from({ length: blocks }, (_, index): ModelMessage[] => [{
    role: "assistant",
    content: "",
    toolCalls: [{ id: `call-${index}`, name: "read", arguments: { path: `file-${index}` } }]
  }, {
    role: "tool",
    toolCallId: `call-${index}`,
    content: `Successful tool receipt ID: call-${index}\nArtifacts (JSON): [{"artifactId":"${"a".repeat(64)}"}]\n${"x".repeat(4_100)}`
  }]).flat();
}

describe("durable tool-result pruning boundary", () => {
  it("protects the newest 40K tokens and freezes old results only after 20K", () => {
    const durable = history(72);
    const before = structuredClone(durable);
    const proposal = proposeToolResultPrune(durable, undefined);
    expect(proposal.changed).toBe(true);
    expect(proposal.protectedTokens).toBeGreaterThanOrEqual(40_000);
    expect(proposal.prunedTokens).toBeGreaterThanOrEqual(20_000);
    expect(proposal.state?.coveredBlocks).toBeGreaterThan(0);

    const projected = projectToolResultHistory(durable, proposal.state);
    expect(projected.length).toBeLessThan(durable.length);
    expect(projected[0]?.role).toBe("assistant");
    expect(projected[0]?.content).toContain("non-executable observation summary");
    expect(projected[0]?.content).toContain("artifactId");
    expect(durable).toEqual(before);

    const unchanged = proposeToolResultPrune(durable, proposal.state);
    expect(unchanged.changed).toBe(false);
    expect(projectToolResultHistory(durable, proposal.state)).toEqual(projected);
  });
});
