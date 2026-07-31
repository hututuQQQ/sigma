import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from "node:fs";
import path from "node:path";
import type { WorkspaceCustomizationTrustAttestation } from "agent-config";
import { workspaceCustomizationManifest } from "agent-extensions";

interface TrustRecord {
  canonicalWorkspacePath: string;
  customizationDigest: string;
  trustedAt: string;
}

interface TrustStore { version: 1; workspaces: TrustRecord[] }

export interface ResolveWorkspaceCustomizationTrustOptions {
  workspacePath: string;
  trustStorePath: string;
  grant: boolean;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function unsupportedSchemaVersion(filePath: string, actual: unknown): Error {
  return Object.assign(new Error(
    `unsupported_schema_version: workspace customization trust store expected 1, received ${String(actual)} at ${filePath}; existing data was not modified`
  ), {
    code: "unsupported_schema_version" as const,
    path: filePath,
    expected: 1,
    actual
  });
}

function invalidPersistedState(filePath: string): Error {
  return Object.assign(new Error(
    `persisted_state_invalid: workspace customization trust store at ${filePath} does not match schema 1; existing data was not modified`
  ), {
    code: "persisted_state_invalid" as const,
    path: filePath
  });
}

function validRecord(value: unknown): value is TrustRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.canonicalWorkspacePath === "string"
    && /^[a-f0-9]{64}$/u.test(String(record.customizationDigest))
    && typeof record.trustedAt === "string";
}

function readStore(filePath: string): TrustStore {
  if (!existsSync(filePath)) return { version: 1, workspaces: [] };
  const content = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw invalidPersistedState(filePath);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidPersistedState(filePath);
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw unsupportedSchemaVersion(filePath, candidate.version);
  }
  if (!Array.isArray(candidate.workspaces) || !candidate.workspaces.every(validRecord)) {
    throw invalidPersistedState(filePath);
  }
  return { version: 1, workspaces: [...candidate.workspaces] };
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // The trust file itself is still fsynced on platforms without directory handles.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWrite(filePath: string, value: TrustStore): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function grantTrust(storePath: string, store: TrustStore, canonicalPath: string, digest: string): void {
  const retained = store.workspaces.filter((record) => !samePath(record.canonicalWorkspacePath, canonicalPath));
  retained.push({ canonicalWorkspacePath: canonicalPath, customizationDigest: digest, trustedAt: new Date().toISOString() });
  atomicWrite(storePath, { version: 1, workspaces: retained });
}

export function resolveWorkspaceCustomizationTrust(
  options: ResolveWorkspaceCustomizationTrustOptions
): WorkspaceCustomizationTrustAttestation & { hasWorkspaceHooks: boolean } {
  const manifest = workspaceCustomizationManifest(options.workspacePath);
  if (options.grant && !manifest.hasWorkspaceHooks) {
    throw new Error("--trust-workspace-customization requires at least one workspace hook in .agent/hooks.");
  }
  const store = readStore(options.trustStorePath);
  if (options.grant) grantTrust(
    options.trustStorePath, store, manifest.canonicalWorkspacePath, manifest.customizationDigest
  );
  const trusted = options.grant || store.workspaces.some((record) =>
    samePath(record.canonicalWorkspacePath, manifest.canonicalWorkspacePath)
    && record.customizationDigest === manifest.customizationDigest);
  return {
    required: true,
    trusted,
    canonicalWorkspacePath: manifest.canonicalWorkspacePath,
    customizationDigest: manifest.customizationDigest,
    hasWorkspaceHooks: manifest.hasWorkspaceHooks
  };
}
