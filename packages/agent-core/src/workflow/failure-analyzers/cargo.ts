import { analysis, combinedOutput, command, failingTestsFromOutput, relatedFilesFromOutput, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class CargoFailureAnalyzer implements FailureAnalyzer {
  readonly name = "cargo";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const output = combinedOutput(input);
    const cmd = command(input);
    if (!/\bcargo\s+(test|check|build)\b/i.test(cmd) && !/\berror\[E\d+\]:|thread '.*' panicked|test result:\s+FAILED/i.test(output)) {
      return null;
    }
    const compileLike = /\berror\[E\d+\]:|could not compile|cannot find|mismatched types/i.test(output);
    return analysis({
      input,
      category: compileLike ? "compile_error" : "test_failure",
      confidence: compileLike ? 0.92 : 0.86,
      analyzerName: this.name,
      primaryPattern: compileLike
        ? /\berror\[E\d+\]:|could not compile|mismatched types|cannot find/i
        : /thread '.*' panicked|test result:\s+FAILED|failures:/i,
      relatedFiles: relatedFilesFromOutput(input),
      failingTestNames: failingTestsFromOutput(input),
      rerunCommandSuggestion: input.command ?? "cargo test"
    });
  }
}
