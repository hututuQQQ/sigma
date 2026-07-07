import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecretText } from "agent-core";

export interface WorkspaceChangeOk {
  handled: true;
  ok: true;
  workspace: string;
  message: string;
}

export interface WorkspaceChangeFailed {
  handled: true;
  ok: false;
  message: string;
}

export type WorkspaceChangeResult =
  | { handled: false }
  | WorkspaceChangeOk
  | WorkspaceChangeFailed;

export const WORKSPACE_HINT = "Use !<command> for shell or /workspace <path> to switch workspace.";
export const SHELL_COMMAND_HINT = "Use !<command> for shell commands.";

export type LocalTerminalInputResult =
  | { handled: false }
  | { handled: true; action: "pwd" | "list" | "clear" | "hint"; message: string };

const LOCAL_COMMANDS = new Set(["pwd", "ls", "dir", "clear", "cls"]);
const SHELL_COMMANDS = new Set([
  "bash",
  "bun",
  "cargo",
  "cat",
  "cmd",
  "cmake",
  "code",
  "cp",
  "curl",
  "deno",
  "docker",
  "dotnet",
  "echo",
  "git",
  "go",
  "grep",
  "java",
  "make",
  "mkdir",
  "mv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "rg",
  "rm",
  "rmdir",
  "sed",
  "sh",
  "ssh",
  "touch",
  "tsc",
  "wget",
  "yarn",
  ...LOCAL_COMMANDS
]);

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function targetFromCd(input: string): string | null {
  const match = /^cd(?:\s+(.*))?$/i.exec(input.trim());
  if (!match) return null;
  return stripQuotes(match[1] ?? "");
}

function firstToken(input: string): string {
  const [token = ""] = input.trim().split(/\s+/, 1);
  return token.toLowerCase().replace(/\.(?:bat|cmd|com|exe|ps1|sh)$/i, "");
}

function looksShellLike(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|[/\\])/.test(trimmed)) return true;
  if (/[;&|<>`]/.test(trimmed)) return true;
  return SHELL_COMMANDS.has(firstToken(trimmed));
}

function formatEntry(name: string, isDirectory: boolean): string {
  return isDirectory ? `${name}/` : name;
}

export function listWorkspaceEntries(workspace: string, limit = 80): string[] {
  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, "en"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`workspace entries unavailable: ${redactSecretText(message)}`];
  }

  if (entries.length === 0) return ["workspace entries: (empty)"];
  const visible = entries.slice(0, Math.max(1, limit));
  const title = entries.length > visible.length
    ? `workspace entries (showing ${visible.length} of ${entries.length}):`
    : `workspace entries (${entries.length}):`;
  return [
    title,
    ...visible.map((entry) => `  ${formatEntry(entry.name, entry.isDirectory)}`)
  ];
}

export function resolveWorkspaceTarget(currentWorkspace: string, target: string): WorkspaceChangeResult {
  const cleanTarget = expandHome(stripQuotes(target));
  if (!cleanTarget) {
    return { handled: true, ok: false, message: WORKSPACE_HINT };
  }
  const workspace = path.resolve(currentWorkspace, cleanTarget);
  let isDirectory = false;
  try {
    isDirectory = fs.existsSync(workspace) && fs.statSync(workspace).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return {
      handled: true,
      ok: false,
      message: `${redactSecretText(workspace)} is not a directory. ${WORKSPACE_HINT}`
    };
  }
  return {
    handled: true,
    ok: true,
    workspace,
    message: `workspace changed to ${redactSecretText(workspace)}`
  };
}

export function resolveLocalWorkspaceInput(input: string, currentWorkspace: string): WorkspaceChangeResult {
  const target = targetFromCd(input);
  if (target === null) return { handled: false };
  return resolveWorkspaceTarget(currentWorkspace, target);
}

export function resolveLocalTerminalInput(input: string): LocalTerminalInputResult {
  const trimmed = input.trim();
  const command = firstToken(trimmed);
  if (LOCAL_COMMANDS.has(command) && trimmed.toLowerCase() === command) {
    if (command === "clear" || command === "cls") return { handled: true, action: "clear", message: "Cleared." };
    if (command === "pwd") return { handled: true, action: "pwd", message: "Workspace printed." };
    return { handled: true, action: "list", message: "Workspace entries listed." };
  }
  if (looksShellLike(trimmed)) return { handled: true, action: "hint", message: SHELL_COMMAND_HINT };
  return { handled: false };
}
