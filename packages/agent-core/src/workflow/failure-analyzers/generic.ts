import { analysis, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class GenericFailureAnalyzer implements FailureAnalyzer {
  readonly name = "generic";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    if (input.ok) return null;
    return analysis({
      input,
      category: "unknown",
      confidence: 0.1,
      analyzerName: this.name
    });
  }
}
