import {
  failureInputFromHarnessResult,
  failureInputFromToolResult,
  suggestedNextActionForFailure,
  type FailureAnalysis,
  type FailureAnalyzer,
  type FailureAnalyzerInput
} from "./failure-analyzers/base.js";
import { CargoFailureAnalyzer } from "./failure-analyzers/cargo.js";
import { GenericFailureAnalyzer } from "./failure-analyzers/generic.js";
import { GoTestFailureAnalyzer } from "./failure-analyzers/go-test.js";
import { MissingToolFailureAnalyzer } from "./failure-analyzers/missing-tool.js";
import { NodeTestFailureAnalyzer } from "./failure-analyzers/node-test.js";
import { PytestFailureAnalyzer } from "./failure-analyzers/pytest.js";
import { SegmentationFaultFailureAnalyzer } from "./failure-analyzers/segmentation-fault.js";
import { TimeoutFailureAnalyzer } from "./failure-analyzers/timeout.js";
import { TypeScriptFailureAnalyzer } from "./failure-analyzers/typescript.js";

export type { FailureAnalysis, FailureAnalyzer, FailureAnalyzerInput } from "./failure-analyzers/base.js";
export {
  failureInputFromHarnessResult,
  failureInputFromToolResult,
  suggestedNextActionForFailure
} from "./failure-analyzers/base.js";
export { CargoFailureAnalyzer } from "./failure-analyzers/cargo.js";
export { GenericFailureAnalyzer } from "./failure-analyzers/generic.js";
export { GoTestFailureAnalyzer } from "./failure-analyzers/go-test.js";
export { MissingToolFailureAnalyzer } from "./failure-analyzers/missing-tool.js";
export { NodeTestFailureAnalyzer } from "./failure-analyzers/node-test.js";
export { PytestFailureAnalyzer } from "./failure-analyzers/pytest.js";
export { SegmentationFaultFailureAnalyzer } from "./failure-analyzers/segmentation-fault.js";
export { TimeoutFailureAnalyzer } from "./failure-analyzers/timeout.js";
export { TypeScriptFailureAnalyzer } from "./failure-analyzers/typescript.js";

export function defaultFailureAnalyzers(): FailureAnalyzer[] {
  return [
    new TimeoutFailureAnalyzer(),
    new MissingToolFailureAnalyzer(),
    new SegmentationFaultFailureAnalyzer(),
    new TypeScriptFailureAnalyzer(),
    new PytestFailureAnalyzer(),
    new GoTestFailureAnalyzer(),
    new CargoFailureAnalyzer(),
    new NodeTestFailureAnalyzer(),
    new GenericFailureAnalyzer()
  ];
}

function withCandidateDiagnostics(best: FailureAnalysis, candidates: FailureAnalysis[]): FailureAnalysis {
  const candidateDiagnostics = candidates
    .filter((candidate) => candidate !== best)
    .map((candidate) => {
      const analyzer = candidate.diagnostics.find((diagnostic) => diagnostic.startsWith("analyzer=")) ?? "analyzer=unknown";
      return `${analyzer}:${candidate.category}:${candidate.confidence.toFixed(2)}`;
    });
  if (candidateDiagnostics.length === 0) return best;
  return {
    ...best,
    diagnostics: [
      ...best.diagnostics,
      `candidates=${candidateDiagnostics.join(",")}`
    ]
  };
}

export class BuiltInFailureAnalyzer implements FailureAnalyzer {
  readonly name = "pipeline";
  private readonly analyzers: FailureAnalyzer[];

  constructor(analyzers: FailureAnalyzer[] = defaultFailureAnalyzers()) {
    this.analyzers = analyzers;
  }

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    if (input.ok) return null;
    const candidates = this.analyzers
      .map((analyzer) => analyzer.analyze(input))
      .filter((candidate): candidate is FailureAnalysis => candidate !== null)
      .sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category, "en"));
    const best = candidates[0];
    return best ? withCandidateDiagnostics(best, candidates) : null;
  }
}

export const defaultFailureAnalyzer = new BuiltInFailureAnalyzer();

export function analyzeFailure(input: FailureAnalyzerInput, analyzer: FailureAnalyzer = defaultFailureAnalyzer): FailureAnalysis | null {
  return analyzer.analyze(input);
}
