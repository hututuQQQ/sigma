import { truncateMiddle } from "../compaction.js";
import { evidenceKindForCommand } from "../controller/evidence.js";
import { planValidationCommandSpecs } from "../harness/validation-planner.js";
import { runHarnessCommand } from "../harness/validation.js";
import { requestToolPermission } from "../policy.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";

type ValidateKind = "auto" | "test" | "lint" | "typecheck" | "build";
type ValidateScope = "changed" | "project" | "file";

interface ValidateArgs {
  kind?: unknown;
  scope?: unknown;
  path?: unknown;
  command?: unknown;
  timeoutSec?: unknown;
}

interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

function kindValue(value: unknown): ValidateKind {
  return value === "test" || value === "lint" || value === "typecheck" || value === "build" ? value : "auto";
}

function scopeValue(value: unknown): ValidateScope {
  return value === "project" || value === "file" ? value : "changed";
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function tailText(value: string, limit = 4000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function projectScopeSeedFiles(kind: ValidateKind): string[] {
  if (kind === "test") return ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
  if (kind === "build" || kind === "typecheck" || kind === "lint") return ["package.json", "tsconfig.json", "pyproject.toml"];
  return ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
}

function parseDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ts = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)$/);
    if (ts) {
      diagnostics.push({
        file: ts[1],
        line: Number(ts[2]),
        column: Number(ts[3]),
        severity: ts[4] === "warning" ? "warning" : "error",
        message: `${ts[5]}: ${ts[6]}`
      });
      continue;
    }
    const pytest = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (pytest && /(failed|error|assert|syntaxerror|traceback)/i.test(line)) {
      diagnostics.push({
        file: pytest[1],
        line: Number(pytest[2]),
        severity: "error",
        message: pytest[3]
      });
    }
  }
  return diagnostics.slice(0, 50);
}

function commandMatchesKind(command: string, kind: ValidateKind): boolean {
  if (kind === "auto") return true;
  return evidenceKindForCommand(command) === kind;
}

async function inferCommand(options: {
  args: ValidateArgs;
  kind: ValidateKind;
  scope: ValidateScope;
  context: ToolExecutionContext;
}): Promise<{ command: string; source: string; relatedFiles: string[] } | null> {
  const changedFiles = options.scope === "file"
    ? typeof options.args.path === "string" ? [options.args.path] : []
    : options.scope === "project"
      ? projectScopeSeedFiles(options.kind)
      : [...options.context.runState.changedFiles];
  const specs = await planValidationCommandSpecs({
    workspacePath: options.context.workspacePath,
    changedFiles
  });
  return specs.find((spec) => commandMatchesKind(spec.command, options.kind)) ?? specs[0] ?? null;
}

export async function executeValidateTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ValidateArgs;
  const kind = kindValue(parsed.kind);
  const scope = scopeValue(parsed.scope);
  const explicitCommand = typeof parsed.command === "string" && parsed.command.trim().length > 0
    ? parsed.command.trim()
    : null;
  const timeoutSec = numberValue(parsed.timeoutSec, context.commandTimeoutSec, 1, 3600);
  const inferred = explicitCommand
    ? { command: explicitCommand, source: "explicit", relatedFiles: typeof parsed.path === "string" ? [parsed.path] : [] }
    : await inferCommand({ args: parsed, kind, scope, context });

  if (!inferred) {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        kind,
        scope,
        command: null,
        diagnostics: [],
        message: "No validation command could be inferred. Provide command explicitly."
      }, null, 2)
    };
  }

  const denied = await requestToolPermission(context, {
    toolName: "validate",
    arguments: { ...parsed, command: inferred.command },
    risk: "execute",
    reason: `Run validation command: ${inferred.command}`
  });
  if (denied) return denied;

  const result = await runHarnessCommand({
    kind: "validation",
    source: inferred.source,
    command: inferred.command,
    workspacePath: context.workspacePath,
    attempt: 1,
    timeoutSec,
    relatedFiles: inferred.relatedFiles,
    abortSignal: context.abortSignal
  });
  const stdoutTail = tailText(result.stdout_tail);
  const stderrTail = tailText(result.stderr_tail);
  const diagnostics = parseDiagnostics(`${stdoutTail}\n${stderrTail}`);
  const payload = {
    ok: result.exit_code === 0,
    command: result.command,
    kind: kind === "auto" ? evidenceKindForCommand(result.command) : kind,
    scope,
    exitCode: result.exit_code,
    durationMs: result.duration_ms,
    cancelled: result.cancelled,
    stdoutTail,
    stderrTail,
    relatedFiles: result.related_files,
    diagnostics
  };
  const content = JSON.stringify(payload, null, 2);
  const truncated = truncateMiddle(content, context.maxToolOutputChars);
  return {
    ok: result.exit_code === 0,
    content: truncated.text,
    metadata: {
      ...payload,
      truncated: truncated.truncated
    }
  };
}
