import path from "node:path";
import type { AgentRunResult, SummaryJson } from "../types.js";
import { summaryJsonFromRunResult } from "../agent.js";

export function relativeArtifactPath(filePath: string, fromDir: string): string {
  return path.relative(fromDir, filePath).split(path.sep).join("/");
}

export function aggregateAttemptResults(attempts: AgentRunResult[]): Pick<
  AgentRunResult,
  "turns" | "toolCalls" | "commandsExecuted" | "usage" | "durationMs"
> {
  return attempts.reduce(
    (total, attempt) => ({
      turns: total.turns + attempt.turns,
      toolCalls: total.toolCalls + attempt.toolCalls,
      commandsExecuted: total.commandsExecuted + attempt.commandsExecuted,
      usage: {
        inputTokens: total.usage.inputTokens + attempt.usage.inputTokens,
        outputTokens: total.usage.outputTokens + attempt.usage.outputTokens,
        cacheTokens: total.usage.cacheTokens + attempt.usage.cacheTokens,
        totalTokens: total.usage.totalTokens + attempt.usage.totalTokens
      },
      durationMs: total.durationMs + attempt.durationMs
    }),
    {
      turns: 0,
      toolCalls: 0,
      commandsExecuted: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 },
      durationMs: 0
    }
  );
}

export function summaryFromAttempt(result: AgentRunResult): SummaryJson {
  return summaryJsonFromRunResult(result);
}
