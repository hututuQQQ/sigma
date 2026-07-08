import {
  analysis,
  combinedOutput,
  command,
  failingTestsFromOutput,
  relatedFilesFromOutput,
  type FailureAnalyzer,
  type FailureAnalyzerInput,
  type FailureAnalysis
} from "./base.js";

export class PytestFailureAnalyzer implements FailureAnalyzer {
  readonly name = "pytest";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const output = combinedOutput(input);
    const cmd = command(input);
    const pytestCommand = /\bpytest\b/i.test(cmd);
    const pytestOutput = /\b(AssertionError|ImportError|ModuleNotFoundError|FAILED\s+[\w./\\-]+\.py::|=+\s+FAILURES\s+=+)\b/.test(output);
    if (!pytestCommand && !pytestOutput) return null;
    return analysis({
      input,
      category: "test_failure",
      confidence: /ImportError|ModuleNotFoundError/.test(output) ? 0.88 : 0.84,
      analyzerName: this.name,
      primaryPattern: /\b(AssertionError|ImportError|ModuleNotFoundError|FAILED\s+[\w./\\-]+\.py::[^\s]+|E\s+assert)\b/i,
      relatedFiles: relatedFilesFromOutput(input),
      failingTestNames: failingTestsFromOutput(input),
      rerunCommandSuggestion: failingTestsFromOutput(input)[0] ? `pytest ${failingTestsFromOutput(input)[0]}` : input.command ?? "pytest"
    });
  }
}
