import { analysis, combinedOutput, command, relatedFilesFromOutput, type FailureAnalyzer, type FailureAnalyzerInput, type FailureAnalysis } from "./base.js";

export class TypeScriptFailureAnalyzer implements FailureAnalyzer {
  readonly name = "typescript";

  analyze(input: FailureAnalyzerInput): FailureAnalysis | null {
    const output = combinedOutput(input);
    const cmd = command(input);
    const hasTsDiagnostic = /\bTS\d{4}:/.test(output);
    const runsTypeScript = /\b(tsc|ts-node|tsx|vue-tsc)\b/i.test(cmd);
    const moduleResolution = /\bCannot find module\b/i.test(output);
    if (!hasTsDiagnostic && !runsTypeScript && !moduleResolution) return null;
    if (!hasTsDiagnostic && runsTypeScript && !/\b(error|typeerror|syntaxerror|cannot find module)\b/i.test(output)) return null;
    return analysis({
      input,
      category: "compile_error",
      confidence: hasTsDiagnostic ? 0.95 : 0.86,
      analyzerName: this.name,
      primaryPattern: /\b(?:error\s+)?TS\d{4}:|Cannot find module|TypeError|SyntaxError/i,
      relatedFiles: relatedFilesFromOutput(input),
      rerunCommandSuggestion: input.command ?? "pnpm exec tsc --noEmit"
    });
  }
}
