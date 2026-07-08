import { analysis, normalizedCombined, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class SegmentationFaultFailureAnalyzer implements FailureAnalyzer {
  readonly name = "segmentation-fault";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const combined = normalizedCombined(input);
    if (
      input.exitCode !== 139 &&
      input.exitCode !== -11 &&
      input.signal !== "SIGSEGV" &&
      !/\b(segmentation fault|sigsegv)\b/.test(combined)
    ) {
      return null;
    }
    return analysis({
      input,
      category: "segmentation_fault",
      confidence: 0.98,
      analyzerName: this.name,
      primaryPattern: /\b(segmentation fault|sigsegv)\b/i
    });
  }
}
