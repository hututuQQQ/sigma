import path from "node:path";
import type { HarnessCommandResult } from "../types.js";
import { runBashCommand } from "../command-runner.js";

export interface ValidationCommandSpec {
  source: string;
  command: string;
  relatedFiles: string[];
  cwd?: string;
}

function tailText(text: string, limit = 4000): string {
  return text.length <= limit ? text : text.slice(-limit);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function scriptRunCommand(filePath: string): string | null {
  const base = path.posix.basename(filePath);
  if (!/^(check|verify|validate|test)(?:[_\-.].*|$)/.test(base)) return null;
  const quoted = shellQuote(filePath);
  if (filePath.endsWith(".py")) return `python ${quoted}`;
  if (filePath.endsWith(".sh")) return `bash ${quoted}`;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return `if command -v node >/dev/null 2>&1; then node ${quoted}; else echo 'node not found for validation' >&2; exit 127; fi`;
  }
  return null;
}

export function explicitValidationCommandSpecs(commands: string[] = []): ValidationCommandSpec[] {
  return commands
    .map((command) => command.trim())
    .filter((command, index, list) => command.length > 0 && list.indexOf(command) === index)
    .map((command) => ({ source: "configured", command, relatedFiles: [] }));
}

export function genericValidationCommandSpecs(changedFiles: string[]): ValidationCommandSpec[] {
  const specs: ValidationCommandSpec[] = [];
  for (const filePath of changedFiles) {
    const quoted = shellQuote(filePath);
    if (filePath.endsWith(".py")) {
      specs.push({ source: "changed-file", command: `python -m py_compile ${quoted}`, relatedFiles: [filePath] });
    } else if (filePath.endsWith(".sh")) {
      specs.push({ source: "changed-file", command: `bash -n ${quoted}`, relatedFiles: [filePath] });
    } else if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
      specs.push({
        source: "changed-file",
        command: `if command -v node >/dev/null 2>&1; then node --check ${quoted}; else echo 'node not found for validation' >&2; exit 127; fi`,
        relatedFiles: [filePath]
      });
    }

    const scriptCommand = scriptRunCommand(filePath);
    if (scriptCommand) {
      specs.push({ source: "changed-script", command: scriptCommand, relatedFiles: [filePath] });
    }
  }
  return specs;
}

export function validationCommandSpecs(
  configuredCommands: string[] = [],
  changedFiles: string[]
): ValidationCommandSpec[] {
  const specs = [
    ...explicitValidationCommandSpecs(configuredCommands),
    ...genericValidationCommandSpecs(changedFiles)
  ];
  const seen = new Set<string>();
  return specs.filter((spec) => {
    if (seen.has(spec.command)) return false;
    seen.add(spec.command);
    return true;
  });
}

export async function runHarnessCommand(options: {
  kind: "validation" | "precheck";
  source: string;
  command: string;
  workspacePath: string;
  attempt: number;
  timeoutSec: number;
  relatedFiles?: string[];
  abortSignal?: AbortSignal;
}): Promise<HarnessCommandResult> {
  const startedAt = Date.now();
  const result = await runBashCommand({
    command: options.command,
    cwd: options.workspacePath,
    env: process.env,
    timeoutMs: Math.max(1, Math.floor(options.timeoutSec * 1000)),
    abortSignal: options.abortSignal
  });

  if (result.error) {
    return {
      kind: options.kind,
      source: options.source,
      command: options.command,
      attempt: options.attempt,
      exit_code: 127,
      stdout_tail: tailText(result.stdout.toString("utf8")),
      stderr_tail: result.error.message,
      related_files: options.relatedFiles ?? [],
      timeout_sec: options.timeoutSec,
      duration_ms: Date.now() - startedAt,
      settled_on: result.settledOn,
      signal: result.signal ?? undefined,
      timed_out: result.timedOut || undefined,
      cancelled: result.cancelled || undefined,
      message: `${options.kind} command failed: ${result.error.message}`
    };
  }

  const code = result.cancelled ? 130 : result.timedOut ? 124 : result.exitCode ?? 1;
  const stdoutTail = tailText(result.stdout.toString("utf8"));
  const stderrTail = tailText(result.stderr.toString("utf8"));
  const label = options.kind === "validation" ? "validation" : "precheck";
  return {
    kind: options.kind,
    source: options.source,
    command: options.command,
    attempt: options.attempt,
    exit_code: code,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    related_files: options.relatedFiles ?? [],
    timeout_sec: options.timeoutSec,
    duration_ms: result.durationMs,
    settled_on: result.settledOn,
    signal: result.signal ?? undefined,
    timed_out: result.timedOut || undefined,
    cancelled: result.cancelled || undefined,
    message: result.cancelled ? `${label} command cancelled` : code === 0 ? `${label} command passed` : `${label} command failed with exit code ${code}`
  };
}
