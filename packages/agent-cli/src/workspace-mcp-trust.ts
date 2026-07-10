import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { WorkspaceMcpTrustAttestation } from "agent-config";

interface WorkspaceMcpTrustRecord {
  canonicalWorkspacePath: string;
  configDigest: string;
  trustedAt: string;
}

interface WorkspaceMcpTrustStore {
  version: 1;
  workspaces: WorkspaceMcpTrustRecord[];
}

export interface ResolveWorkspaceMcpTrustOptions {
  workspacePath: string;
  configSource: string;
  trustStorePath: string;
  grant: boolean;
}

function digest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function emptyStore(): WorkspaceMcpTrustStore {
  return { version: 1, workspaces: [] };
}

function validRecord(value: unknown): value is WorkspaceMcpTrustRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.canonicalWorkspacePath === "string"
    && /^[a-f0-9]{64}$/.test(String(record.configDigest))
    && typeof record.trustedAt === "string";
}

function readStore(filePath: string): WorkspaceMcpTrustStore {
  if (!existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return emptyStore();
    return { version: 1, workspaces: parsed.workspaces.filter(validRecord) };
  } catch {
    return emptyStore();
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some platforms do not expose directory handles; the file itself was still fsynced.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWrite(filePath: string, value: WorkspaceMcpTrustStore): void {
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

function grantTrust(
  storePath: string,
  store: WorkspaceMcpTrustStore,
  canonicalWorkspacePath: string,
  configDigest: string
): void {
  const retained = store.workspaces.filter((record) => !samePath(record.canonicalWorkspacePath, canonicalWorkspacePath));
  retained.push({ canonicalWorkspacePath, configDigest, trustedAt: new Date().toISOString() });
  atomicWrite(storePath, { version: 1, workspaces: retained });
}

export function resolveWorkspaceMcpTrust(options: ResolveWorkspaceMcpTrustOptions): WorkspaceMcpTrustAttestation {
  const canonicalWorkspacePath = realpathSync.native(path.resolve(options.workspacePath));
  const configDigest = digest(options.configSource);
  const store = readStore(options.trustStorePath);
  if (options.grant) grantTrust(options.trustStorePath, store, canonicalWorkspacePath, configDigest);
  const trusted = options.grant || store.workspaces.some((record) =>
    samePath(record.canonicalWorkspacePath, canonicalWorkspacePath) && record.configDigest === configDigest
  );
  return { required: true, trusted, canonicalWorkspacePath, configDigest };
}
