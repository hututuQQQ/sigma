import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore
} from "@earendil-works/pi-ai";
import {
  acquireProcessOwnerLease,
  ensurePrivateStateDirectory,
  restrictWindowsPathToCurrentUser,
  syncDirectory,
  type ProcessOwnerLease
} from "agent-platform";

interface CredentialDocument {
  version: 1;
  credentials: Record<string, Credential>;
}

export interface FileCredentialStoreOptions {
  filePath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultSigmaCredentialPath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.SIGMA_CREDENTIAL_FILE?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw Object.assign(new Error(
        "credential_path_invalid: SIGMA_CREDENTIAL_FILE must be an absolute path"
      ), {
        code: "credential_path_invalid" as const
      });
    }
    return path.resolve(configured);
  }
  return path.join(homeDir, ".sigma", "auth.json");
}

function emptyDocument(): CredentialDocument {
  return { version: 1, credentials: {} };
}

function unsupportedSchemaVersion(filePath: string, actual: unknown): Error {
  return Object.assign(new Error(
    `unsupported_schema_version: Sigma credential file expected 1, received ${String(actual)} at ${filePath}; existing data was not modified`
  ), {
    code: "unsupported_schema_version" as const,
    path: filePath,
    expected: 1,
    actual
  });
}

function invalidPersistedState(filePath: string): Error {
  return Object.assign(new Error(
    `persisted_state_invalid: Sigma credential file at ${filePath} does not match schema 1; existing data was not modified`
  ), {
    code: "persisted_state_invalid" as const,
    path: filePath
  });
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    return (candidate.key === undefined || typeof candidate.key === "string")
      && (candidate.env === undefined || Boolean(candidate.env && typeof candidate.env === "object"));
  }
  return candidate.type === "oauth"
    && typeof candidate.access === "string"
    && typeof candidate.refresh === "string"
    && typeof candidate.expires === "number";
}

function parseDocument(value: unknown, filePath: string): CredentialDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPersistedState(filePath);
  }
  const candidate = value as { version?: unknown; credentials?: unknown };
  if (candidate.version !== 1) {
    throw unsupportedSchemaVersion(filePath, candidate.version);
  }
  if (!candidate.credentials || typeof candidate.credentials !== "object"
    || Array.isArray(candidate.credentials)) {
    throw invalidPersistedState(filePath);
  }
  const entries = Object.entries(candidate.credentials);
  if (!entries.every((entry): entry is [string, Credential] =>
    entry[0].length > 0 && isCredential(entry[1]))) {
    throw invalidPersistedState(filePath);
  }
  const credentials = Object.fromEntries(entries);
  return { version: 1, credentials };
}

async function readPrivateJson(filePath: string): Promise<CredentialDocument> {
  const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return emptyDocument();
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Sigma credential path is not a regular file.");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Sigma credential file permissions are not private.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile("utf8");
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error("Sigma credential file contains invalid JSON.");
    }
    return parseDocument(value, filePath);
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await restrictWindowsPathToCurrentUser(temporary, { directory: false });
    await rename(temporary, filePath);
    published = true;
    await syncDirectory(path.dirname(filePath));
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly filePath: string;

  constructor(options: FileCredentialStoreOptions = {}) {
    this.filePath = path.resolve(
      options.filePath ?? defaultSigmaCredentialPath(options.homeDir, options.env)
    );
  }

  private async prepareDirectory(): Promise<void> {
    const directory = await ensurePrivateStateDirectory(path.dirname(this.filePath));
    await restrictWindowsPathToCurrentUser(directory, { directory: true });
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    await this.prepareDirectory();
    const lease = await acquireProcessOwnerLease(
      `${this.filePath}.lock`,
      { pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() },
      { label: "Sigma credential store", timeoutMs: 30_000 }
    );
    try {
      return await run();
    } finally {
      await lease.release();
    }
  }

  async acquireLoginLease(signal?: AbortSignal): Promise<ProcessOwnerLease> {
    await this.prepareDirectory();
    return await acquireProcessOwnerLease(
      `${this.filePath}.login.lock`,
      { pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() },
      {
        label: "Sigma provider authentication",
        timeoutMs: 1_000,
        activeOwner: "reject",
        ...(signal ? { signal } : {})
      }
    );
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await readPrivateJson(this.filePath)).credentials[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const document = await readPrivateJson(this.filePath);
    return Object.entries(document.credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return await this.withLock(async () => {
      const document = await readPrivateJson(this.filePath);
      const current = document.credentials[providerId];
      const replacement = await fn(current);
      if (replacement === undefined) return current;
      document.credentials[providerId] = replacement;
      await writePrivateJson(this.filePath, `${JSON.stringify(document, null, 2)}\n`);
      return replacement;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const document = await readPrivateJson(this.filePath);
      if (!(providerId in document.credentials)) return;
      delete document.credentials[providerId];
      await writePrivateJson(this.filePath, `${JSON.stringify(document, null, 2)}\n`);
    });
  }
}
