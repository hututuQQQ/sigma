import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HarnessCommandResult, SummaryJson } from "../types.js";

export interface ValidationCommandSpec {
  source: string;
  command: string;
  relatedFiles: string[];
}

function tailText(text: string, limit = 4000): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bashExecutable(): string {
  if (process.env.AGENT_BASH_PATH) return process.env.AGENT_BASH_PATH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe"
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return "bash";
}

function validationCommandsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((command): command is string => typeof command === "string" && command.trim().length > 0);
}

export function summaryValidationCommands(summary: SummaryJson | Record<string, unknown> | undefined): ValidationCommandSpec[] {
  if (!summary || typeof summary !== "object") return [];
  const commands = [
    ...validationCommandsFromValue((summary as { validation_commands?: unknown }).validation_commands),
    ...validationCommandsFromValue((summary as { validationCommands?: unknown }).validationCommands)
  ];
  const harness = (summary as { harness?: unknown }).harness;
  if (harness && typeof harness === "object") {
    commands.push(
      ...validationCommandsFromValue((harness as { validation_commands?: unknown }).validation_commands),
      ...validationCommandsFromValue((harness as { validationCommands?: unknown }).validationCommands)
    );
  }
  return [...new Set(commands)].map((command) => ({ source: "summary", command, relatedFiles: [] }));
}

function scriptRunCommand(filePath: string): string | null {
  const base = path.posix.basename(filePath);
  if (!/^(check|verify|validate|test)_/.test(base)) return null;
  const quoted = shellQuote(filePath);
  if (filePath.endsWith(".py")) return `python ${quoted}`;
  if (filePath.endsWith(".sh")) return `bash ${quoted}`;
  if (filePath.endsWith(".js")) {
    return `if command -v node >/dev/null 2>&1; then node ${quoted}; else echo 'node not found for validation' >&2; exit 127; fi`;
  }
  return null;
}

export function genericValidationCommandSpecs(changedFiles: string[]): ValidationCommandSpec[] {
  const specs: ValidationCommandSpec[] = [];
  for (const filePath of changedFiles) {
    const quoted = shellQuote(filePath);
    if (filePath.endsWith(".py")) {
      specs.push({ source: "changed-file", command: `python -m py_compile ${quoted}`, relatedFiles: [filePath] });
    } else if (filePath.endsWith(".sh")) {
      specs.push({ source: "changed-file", command: `bash -n ${quoted}`, relatedFiles: [filePath] });
    } else if (filePath.endsWith(".js")) {
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

export function validationCommandSpecs(summary: SummaryJson, changedFiles: string[]): ValidationCommandSpec[] {
  const specs = [...summaryValidationCommands(summary), ...genericValidationCommandSpecs(changedFiles)];
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
}): Promise<HarnessCommandResult> {
  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;

  return await new Promise<HarnessCommandResult>((resolve) => {
    const child = spawn(bashExecutable(), ["-lc", options.command], {
      cwd: options.workspacePath,
      env: process.env,
      windowsHide: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500).unref();
    }, Math.max(1, Math.floor(options.timeoutSec * 1000)));

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        kind: options.kind,
        source: options.source,
        command: options.command,
        attempt: options.attempt,
        exit_code: 127,
        stdout_tail: "",
        stderr_tail: error.message,
        related_files: options.relatedFiles ?? [],
        timeout_sec: options.timeoutSec,
        duration_ms: Date.now() - startedAt,
        message: `${options.kind} command failed: ${error.message}`
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const code = timedOut ? 124 : exitCode ?? 1;
      const stdoutTail = tailText(Buffer.concat(stdoutChunks).toString("utf8"));
      const stderrTail = tailText(Buffer.concat(stderrChunks).toString("utf8"));
      const label = options.kind === "validation" ? "validation" : "precheck";
      resolve({
        kind: options.kind,
        source: options.source,
        command: options.command,
        attempt: options.attempt,
        exit_code: code,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail,
        related_files: options.relatedFiles ?? [],
        timeout_sec: options.timeoutSec,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut || undefined,
        message: code === 0 ? `${label} command passed` : `${label} command failed with exit code ${code}`
      });
    });
  });
}
