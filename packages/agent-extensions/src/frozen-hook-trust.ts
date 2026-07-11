import path from "node:path";
import type { FrozenSessionHook } from "./frozen-customization.js";
import {
  workspaceCustomizationManifest,
  type WorkspaceCustomizationFile,
  type WorkspaceCustomizationManifest
} from "./workspace-customization.js";

export interface FrozenWorkspaceHookTrust {
  canonicalWorkspacePath: string;
  customizationDigest: string;
  files: readonly WorkspaceCustomizationFile[];
}

export function freezeWorkspaceHookTrust(
  manifest: WorkspaceCustomizationManifest
): FrozenWorkspaceHookTrust {
  return {
    canonicalWorkspacePath: manifest.canonicalWorkspacePath,
    customizationDigest: manifest.customizationDigest,
    files: manifest.files.map((item) => ({ ...item }))
  };
}

export function verifyFrozenWorkspaceHookTrust(workspacePath: string, hook: FrozenSessionHook): void {
  if (hook.source !== "workspace" || hook.definition.kind !== "command") return;
  if (!hook.trust) throw new Error(`Frozen workspace hook '${hook.id}' has no durable trust manifest.`);
  const current = workspaceCustomizationManifest(workspacePath);
  if (!samePath(current.canonicalWorkspacePath, hook.trust.canonicalWorkspacePath)
    || current.customizationDigest !== hook.trust.customizationDigest) {
    throw new Error(`Frozen workspace hook '${hook.id}' assets changed after explicit trust; start a newly trusted session.`);
  }
  const currentFiles = new Map(current.files.map((item) => [item.relativePath, item]));
  for (const expected of hook.trust.files) {
    const actual = currentFiles.get(expected.relativePath);
    if (!actual || actual.digest !== expected.digest || actual.mode !== expected.mode || actual.size !== expected.size) {
      throw new Error(`Frozen workspace hook '${hook.id}' asset '${expected.relativePath}' changed after explicit trust.`);
    }
  }
}

export function frozenWorkspaceHookTrustValue(value: unknown): FrozenWorkspaceHookTrust {
  const item = object(value, "hook trust");
  exact(item, ["canonicalWorkspacePath", "customizationDigest", "files"], "hook trust");
  const canonicalWorkspacePath = text(item.canonicalWorkspacePath, "hook trust workspace");
  if (!path.isAbsolute(canonicalWorkspacePath)) throw new Error("Frozen hook trust workspace must be absolute.");
  const customizationDigest = digest(item.customizationDigest, "hook trust digest");
  if (!Array.isArray(item.files)) throw new Error("Frozen hook trust files must be an array.");
  const files = item.files.map((value): WorkspaceCustomizationFile => {
    const file = object(value, "hook trust file");
    exact(file, ["relativePath", "mode", "size", "digest"], "hook trust file");
    const relativePath = text(file.relativePath, "hook trust file path");
    if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error("Frozen hook trust file path escapes its workspace.");
    }
    const mode = integer(file.mode, "hook trust file mode");
    const size = integer(file.size, "hook trust file size");
    return { relativePath, mode, size, digest: digest(file.digest, "hook trust file digest") };
  });
  if (new Set(files.map((item) => item.relativePath)).size !== files.length) {
    throw new Error("Frozen hook trust contains duplicate file paths.");
  }
  return { canonicalWorkspacePath, customizationDigest, files };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Frozen ${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error(`Frozen ${label} has invalid fields.`);
  }
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Frozen ${label} must be text.`);
  return value;
}
function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`Frozen ${label} is invalid.`);
  return result;
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Frozen ${label} is invalid.`);
  return Number(value);
}
