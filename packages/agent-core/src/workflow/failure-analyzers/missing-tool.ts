import { analysis, combinedOutput, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class MissingToolFailureAnalyzer implements FailureAnalyzer {
  readonly name = "missing-tool";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const output = combinedOutput(input).toLowerCase();
    if (
      input.exitCode !== 127 &&
      !/\b(command not found|not found for validation|no such file or directory|enoent|is not recognized as an internal or external command)\b/.test(output)
    ) {
      return null;
    }
    return analysis({
      input,
      category: "missing_tool",
      confidence: 0.97,
      analyzerName: this.name,
      primaryPattern: /\b(command not found|not found for validation|no such file or directory|enoent|is not recognized as an internal or external command)\b/i,
      shouldAvoidRepeatingCommand: true
    });
  }
}
