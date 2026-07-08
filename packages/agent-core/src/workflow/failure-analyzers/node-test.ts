import { analysis, combinedOutput, command, failingTestsFromOutput, relatedFilesFromOutput, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class NodeTestFailureAnalyzer implements FailureAnalyzer {
  readonly name = "node-test";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const output = combinedOutput(input);
    const cmd = command(input);
    const nodeTestCommand = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|node\s+--test)\b/i.test(cmd);
    const nodeTestOutput = /\b(FAIL|AssertionError|Expected|Received|expected .* received|expected .* got|Test Files\s+\d+\s+failed)\b/i.test(output);
    if (!nodeTestCommand && !nodeTestOutput) return null;
    return analysis({
      input,
      category: "test_failure",
      confidence: 0.82,
      analyzerName: this.name,
      primaryPattern: /\b(FAIL|AssertionError|Expected|Received|expected .* received|expected .* got|Test Files\s+\d+\s+failed)\b/i,
      relatedFiles: relatedFilesFromOutput(input),
      failingTestNames: failingTestsFromOutput(input),
      rerunCommandSuggestion: input.command ?? "pnpm test"
    });
  }
}
