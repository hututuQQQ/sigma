import { analysis, normalizedCombined, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class TimeoutFailureAnalyzer implements FailureAnalyzer {
  readonly name = "timeout";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const combined = normalizedCombined(input);
    if (!input.timedOut && input.exitCode !== 124 && !/\btimedout:\s*true\b|\btimed out\b|\btimeout\b/.test(combined)) {
      return null;
    }
    return analysis({
      input,
      category: "timeout",
      confidence: 0.99,
      analyzerName: this.name,
      primaryPattern: /\b(timed out|timeout|timedout)\b/i,
      shouldAvoidRepeatingCommand: true
    });
  }
}
