import { describe, expect, it } from "vitest";
import { formatFailureCard, instructionWithRetryFeedback } from "../packages/agent-core/src/harness/retry.js";
import type { AgentRunResult, HarnessCommandResult, SummaryJson } from "../packages/agent-core/src/index.js";

function failedResult(overrides: Partial<HarnessCommandResult> = {}): HarnessCommandResult {
  return {
    kind: "validation",
    source: "project-node",
    command: "pnpm test",
    attempt: 1,
    exit_code: 1,
    stdout_tail: "a".repeat(5000),
    stderr_tail: "AssertionError: expected true\n",
    related_files: ["src/app.ts"],
    timeout_sec: 60,
    duration_ms: 100,
    message: "validation failed",
    ...overrides
  };
}

describe("retry feedback cards", () => {
  it("formats compact failure cards", () => {
    const card = formatFailureCard(failedResult(), 0);

    expect(card).toContain("Validation failure 1 card:");
    expect(card).toContain("- command: pnpm test");
    expect(card).toContain("- exit code: 1");
    expect(card).toContain("- related files: src/app.ts");
    expect(card).toContain("- category: test_failure");
    expect(card).toContain("- next action:");
    expect(card.length).toBeLessThan(2500);
  });

  it("keeps retry instruction compact and truncates trace tail", () => {
    const previousAttemptResult = {
      status: "completed",
      finishReason: "assistant_stop",
      turns: 2,
      toolCalls: 1,
      commandsExecuted: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 },
      provider: "deepseek",
      model: "fake",
      durationMs: 10,
      lastError: null
    } satisfies AgentRunResult;
    const previousAttemptSummary = {
      status: "completed",
      finish_reason: "assistant_stop",
      turns: 2,
      tool_calls: 1,
      commands_executed: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_tokens: 0,
      cost_usd: null,
      provider: "deepseek",
      model: "fake",
      duration_ms: 10,
      last_error: null
    } satisfies SummaryJson;

    const instruction = instructionWithRetryFeedback({
      originalInstruction: "fix it",
      failedResults: [failedResult()],
      previousAttemptSummary,
      previousAttemptResult,
      traceTail: "trace\n".repeat(2000)
    });

    expect(instruction).toContain("failure 1 card");
    expect(instruction).toContain("Trace tail key events (truncated):");
    expect(instruction.length).toBeLessThan(7000);
  });
});
