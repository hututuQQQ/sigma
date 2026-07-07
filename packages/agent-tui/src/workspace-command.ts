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
