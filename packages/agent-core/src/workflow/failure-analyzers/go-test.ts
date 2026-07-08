import { analysis, combinedOutput, command, failingTestsFromOutput, relatedFilesFromOutput, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class GoTestFailureAnalyzer implements FailureAnalyzer {
  readonly name = "go-test";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const output = combinedOutput(input);
    const cmd = command(input);
    if (!/\bgo\s+test\b/i.test(cmd) && !/--- FAIL:|FAIL\s+[\w./-]+|\bgo: build failed\b/i.test(output)) return null;
    const compileLike = /\b(undefined:|cannot use|expected declaration|syntax error|build failed|no required module provides package)\b/i.test(output);
    return analysis({
      input,
      category: compileLike ? "compile_error" : "test_failure",
      confidence: compileLike ? 0.9 : 0.86,
      analyzerName: this.name,
      primaryPattern: compileLike
        ? /\b(undefined:|cannot use|expected declaration|syntax error|build failed|no required module provides package)\b/i
        : /--- FAIL:|FAIL\s+[\w./-]+|expected .* got/i,
      relatedFiles: relatedFilesFromOutput(input),
      failingTestNames: failingTestsFromOutput(input),
      rerunCommandSuggestion: input.command ?? "go test ./..."
    });
  }
}
