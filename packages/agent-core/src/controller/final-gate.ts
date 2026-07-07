import type {
  AgentFinalEvidenceMode,
  EvidenceRecord,
  FinalGateStatus,
  WorkflowStateSummary
} from "../types.js";

const CODE_OR_CONFIG_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".sh",
  ".bash",
  ".zsh",
  ".toml",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".gradle"
]);

const CODE_MARKER_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile"
]);

function looksLikeCodeFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  if (CODE_MARKER_FILES.has(base)) return true;
  const dotIndex = base.lastIndexOf(".");
  return dotIndex >= 0 && CODE_OR_CONFIG_EXTENSIONS.has(base.slice(dotIndex));
}

function instructionLooksExecutable(instruction: string): boolean {
  return /\b(fix|debug|implement|refactor|test|build|lint|typecheck|compile|run|script|cli|api|server|package|typescript|javascript|python|go|rust|java|shell)\b/i.test(
    instruction
  );
}

function taskNeedsExecutableEvidence(instruction: string, changedFiles: string[]): boolean {
  if (changedFiles.some(looksLikeCodeFile)) return true;
  if (changedFiles.length > 0) return instructionLooksExecutable(instruction);
  return instructionLooksExecutable(instruction);
}

function hasExecutableEvidence(evidenceRecords: EvidenceRecord[]): boolean {
  return evidenceRecords.some((record) => record.ok && record.executable);
}

function suggestedVerification(changedFiles: string[], commandsTried: string[]): string {
  const lastVerification = [...commandsTried]
    .reverse()
    .find((command) => /\b(test|build|lint|check|verify|validate|pytest|tsc|go test|cargo test|mvn test|gradle test)\b/i.test(command));
  if (lastVerification) return `Rerun or repair: ${lastVerification}`;
  if (changedFiles.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) return "Try a TypeScript typecheck or the package test script.";
  if (changedFiles.some((file) => file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))) return "Try the package test script or node --check on changed JavaScript files.";
  if (changedFiles.some((file) => file.endsWith(".py"))) return "Try python -m pytest -q or python -m py_compile on changed Python files.";
  if (changedFiles.some((file) => file.endsWith(".go"))) return "Try go test ./...";
  if (changedFiles.some((file) => file.endsWith(".rs"))) return "Try cargo test.";
  return "Run the most relevant test, build, lint, typecheck, or validation command.";
}

export function createInitialFinalGateStatus(mode: AgentFinalEvidenceMode): FinalGateStatus {
  return { mode, nudged: false, status: mode === "off" ? "off" : "not-needed" };
}

export function finalGateNudge(options: {
  mode: AgentFinalEvidenceMode;
  alreadyNudged: boolean;
  instruction: string;
  workflow: WorkflowStateSummary;
  evidenceRecords: EvidenceRecord[];
  turns: number;
  maxTurns: number;
}): { message?: string; status: FinalGateStatus } {
  if (options.mode === "off") {
    return { status: { mode: options.mode, nudged: options.alreadyNudged, status: "off" } };
  }
  if (hasExecutableEvidence(options.evidenceRecords)) {
    return { status: { mode: options.mode, nudged: options.alreadyNudged, status: "satisfied" } };
  }
  if (!taskNeedsExecutableEvidence(options.instruction, options.workflow.changed_files)) {
    return {
      status: {
        mode: options.mode,
        nudged: options.alreadyNudged,
        status: "not-needed",
        reason: "task_does_not_appear_to_require_executable_verification"
      }
    };
  }
  if (options.alreadyNudged) {
    return {
      status: {
        mode: options.mode,
        nudged: true,
        status: "allowed-after-nudge",
        reason: "already_asked_for_verification_or_blocker"
      }
    };
  }
  if (options.turns >= options.maxTurns) {
    return {
      status: {
        mode: options.mode,
        nudged: false,
        status: "budget-exhausted",
        reason: "max_turn_budget_exhausted"
      }
    };
  }

  const suggestion = suggestedVerification(options.workflow.changed_files, options.workflow.commands_tried);
  return {
    message: [
      "Before giving the final answer, please run a relevant verification command and use the result as evidence.",
      suggestion,
      "If verification is genuinely blocked, explain the blocker clearly in the final response."
    ].join("\n"),
    status: {
      mode: options.mode,
      nudged: true,
      status: "nudged",
      reason: "missing_executable_verification_evidence"
    }
  };
}
