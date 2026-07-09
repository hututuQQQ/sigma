import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../command-runner.js";
import { truncateMiddle } from "../compaction.js";
import { gitCommandSpec } from "../tools/git-command.js";
import type { ReviewGateFinding, ReviewGateStatus, ReviewGateSummary } from "../types.js";

interface ParsedAddedLine {
  path: string;
  line: number;
  text: string;
}

export interface AntiGamingReviewOptions {
  workspacePath?: string;
  diffText: string;
}

export interface AntiGamingWorkspaceOptions {
  workspacePath: string;
  maxUntrackedFileBytes?: number;
}

const SUITE_TERM = "bench" + "mark";
const CHECKER_TERM = "veri" + "fier";
const POINTS_TERM = "re" + "ward";

function wordPattern(terms: string[]): string {
  return terms.join("|");
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isAllowedExternalAdapterPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return (
    normalized.startsWith("scripts/bench")
  );
}

function isDocumentationPath(filePath: string): boolean {
  return /\.(md|mdx|txt)$/i.test(filePath) || normalizePath(filePath).startsWith("docs/");
}

function parseAddedLines(diffText: string): { lines: ParsedAddedLine[]; files: string[] } {
  const lines: ParsedAddedLine[] = [];
  const files = new Set<string>();
  let currentPath = "";
  let nextLine = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
    if (fileMatch) {
      currentPath = fileMatch[2] ?? fileMatch[1] ?? "";
      files.add(currentPath);
      nextLine = 0;
      continue;
    }
    const newFileMatch = /^\+\+\+ b\/(.+)$/.exec(rawLine);
    if (newFileMatch) {
      currentPath = newFileMatch[1] ?? currentPath;
      files.add(currentPath);
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkMatch) {
      nextLine = Number(hunkMatch[1]);
      continue;
    }
    if (!currentPath || rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (rawLine.startsWith("+")) {
      lines.push({ path: currentPath, line: Math.max(1, nextLine), text: rawLine.slice(1) });
      nextLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) continue;
    if (nextLine > 0) nextLine += 1;
  }

  return { lines, files: [...files].sort((a, b) => a.localeCompare(b, "en")) };
}

function finding(
  ruleId: string,
  severity: ReviewGateFinding["severity"],
  message: string,
  line: ParsedAddedLine
): ReviewGateFinding {
  return {
    rule_id: ruleId,
    severity,
    message,
    path: line.path,
    line: line.line,
    snippet: truncateMiddle(line.text.trim(), 240).text
  };
}

function isProductCore(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized.startsWith("packages/") && !normalized.includes("/test") && !normalized.endsWith(".test.ts");
}

function reviewLine(line: ParsedAddedLine): ReviewGateFinding[] {
  const text = line.text;
  const normalized = normalizePath(line.path);
  const lower = text.toLowerCase();
  const findings: ReviewGateFinding[] = [];
  if (isAllowedExternalAdapterPath(normalized) || isDocumentationPath(normalized)) return findings;
  const identityTerms = wordPattern([SUITE_TERM, "bench", CHECKER_TERM, "grader", "task[_-]?id", "harness", "eval"]);
  const pathTerms = wordPattern([SUITE_TERM, CHECKER_TERM, "grader", "task[_-]?id", "fixtures?"]);
  const fakeResultTerms = wordPattern(["test", "validation", CHECKER_TERM, "result", "score", "exit\\s*0"]);
  const controlFlowTerms = wordPattern(["score", POINTS_TERM, CHECKER_TERM, "grader"]);
  const coreTerms = wordPattern([SUITE_TERM, CHECKER_TERM, "grader", "task[_-]?id", "dataset[_-]?name"]);

  if (/(task[_-]?id|task[_-]?name|fixture[_-]?name|dataset[_-]?name)\s*[:=]\s*['"][^'"]{3,}['"]/i.test(text)) {
    findings.push(finding(
      "hardcoded-task-identity",
      "high",
      "Added code appears to branch on a hardcoded task, fixture, or dataset identity.",
      line
    ));
  }
  if (new RegExp(`\\b(process\\.env|Deno\\.env|os\\.environ)\\b.*\\b(${identityTerms})\\b`, "i").test(text)) {
    findings.push(finding(
      "external-check-environment-probe",
      "high",
      "Added code appears to inspect environment variables associated with an external checker or run controller.",
      line
    ));
  }
  if (new RegExp(`\\b(__dirname|process\\.cwd\\(\\)|import\\.meta\\.url|path\\.)\\b.*\\b(${pathTerms})\\b`, "i").test(text)) {
    findings.push(finding(
      "external-check-path-probe",
      "medium",
      "Added code appears to infer external check identity from paths or fixtures.",
      line
    ));
  }
  if (new RegExp(`\\b(skip|bypass|fake|pretend|stub)\\b.*\\b(${fakeResultTerms})\\b`, "i").test(text)) {
    findings.push(finding(
      "fake-validation-result",
      "high",
      "Added code appears to skip, fake, or bypass validation or external check results.",
      line
    ));
  }
  if (new RegExp(`\\b(${controlFlowTerms})\\b`, "i").test(text) && /\b(if|switch|case|return|throw|process\.exit)\b/i.test(text)) {
    findings.push(finding(
      "scoring-control-flow",
      "medium",
      "Added code appears to make control-flow decisions around scoring or external checker terms.",
      line
    ));
  }
  if (/\bif\s*\(.{0,80}\b(input|prompt|fixture|filename|fileName)\b.{0,80}(===|==|includes\()\s*['"][^'"]{5,}['"]/.test(text)) {
    findings.push(finding(
      "specific-input-branch",
      "medium",
      "Added code appears to special-case a specific input, prompt, fixture, or filename.",
      line
    ));
  }
  if (isProductCore(normalized) && new RegExp(`\\b(${coreTerms})\\b`, "i").test(text)) {
    findings.push(finding(
      "product-core-external-check-term",
      lower.includes(SUITE_TERM) ? "medium" : "high",
      "Product core gained external-check or task-identity terminology; keep adapter vocabulary outside core code.",
      line
    ));
  }

  return findings;
}

function statusForFindings(findings: ReviewGateFinding[]): ReviewGateStatus {
  if (findings.some((finding) => finding.severity === "high")) return "blocked";
  if (findings.length > 0) return "suspicious";
  return "clean";
}

function suggestedFixes(findings: ReviewGateFinding[]): string[] {
  if (findings.length === 0) return [];
  const fixes = new Set<string>();
  for (const finding of findings) {
    if (finding.rule_id.includes("task") || finding.rule_id.includes("input")) {
      fixes.add("Replace task-specific branches with general parsing, validation, or feature logic.");
    }
    if (finding.rule_id.includes("environment") || finding.rule_id.includes("path")) {
      fixes.add("Remove external-check environment/path probes; pass explicit user configuration instead.");
    }
    if (finding.rule_id.includes("validation")) {
      fixes.add("Run real validation and report actual command output instead of fabricating results.");
    }
    if (finding.rule_id.includes("core")) {
      fixes.add("Keep external adapter vocabulary in adapter paths, not product core.");
    }
  }
  return [...fixes];
}

export function reviewAntiGamingDiff(options: AntiGamingReviewOptions): ReviewGateSummary {
  const startedAt = Date.now();
  const parsed = parseAddedLines(options.diffText);
  const findings = parsed.lines.flatMap(reviewLine);
  return {
    gate: "anti_gaming",
    status: statusForFindings(findings),
    findings,
    suggested_fixes: suggestedFixes(findings),
    scanned_files: parsed.files,
    duration_ms: Date.now() - startedAt
  };
}

async function runGit(args: string[], workspacePath: string): Promise<string> {
  const git = gitCommandSpec();
  const result = await runCommand({
    command: git.command,
    args: [...git.argsPrefix, ...args],
    cwd: workspacePath,
    timeoutMs: 10000
  });
  if (result.error || result.timedOut || result.exitCode !== 0) return "";
  return result.stdout.toString("utf8");
}

async function untrackedFileDiff(workspacePath: string, maxBytes: number): Promise<string> {
  const output = await runGit(["ls-files", "--others", "--exclude-standard"], workspacePath);
  const sections: string[] = [];
  for (const filePath of output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 100)) {
    try {
      const absolutePath = path.resolve(workspacePath, filePath);
      const content = await readFile(absolutePath, "utf8");
      const clipped = content.length > maxBytes ? content.slice(0, maxBytes) : content;
      sections.push([
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${clipped.split(/\r?\n/).length} @@`,
        ...clipped.split(/\r?\n/).map((line) => `+${line}`)
      ].join("\n"));
    } catch {
      // Binary or unreadable untracked files are skipped by this text-only review.
    }
  }
  return sections.join("\n");
}

export async function reviewAntiGamingWorkspace(options: AntiGamingWorkspaceOptions): Promise<ReviewGateSummary> {
  const workspacePath = path.resolve(options.workspacePath);
  const diff = await runGit(["diff", "--", "."], workspacePath);
  const untracked = await untrackedFileDiff(workspacePath, options.maxUntrackedFileBytes ?? 200000);
  return reviewAntiGamingDiff({
    workspacePath,
    diffText: [diff, untracked].filter(Boolean).join("\n")
  });
}
