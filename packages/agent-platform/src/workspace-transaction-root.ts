import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInside } from "./workspace.js";
import { lockWindowsDirectories, type WindowsDirectoryLock } from "./windows-directory-lock.js";

export interface WorkspaceTransactionRootOptions {
  workspacePath: string;
  stateRootDir?: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export class WorkspaceTransactionRootError extends Error {
  readonly code = "workspace_transaction_root_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceTransactionRootError";
  }
}

export class WorkspaceTransactionCleanupWarning extends Error {
  readonly code = "workspace_transaction_cleanup_failed";
  readonly directory: string;

  constructor(directory: string, options?: ErrorOptions) {
    super(`Workspace transaction container cleanup failed: ${directory}`, options);
    this.name = "WorkspaceTransactionCleanupWarning";
    this.directory = directory;
  }
}

export interface WorkspaceTransactionDirectoryLease {
  verify(): Promise<void>;
  close(): Promise<void>;
}

function safeNamespace(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw new Error(`Unsafe workspace transaction namespace: ${value}`);
  }
  return value;
}

function defaultStateHome(options: WorkspaceTransactionRootOptions): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (env.SIGMA_STATE_HOME) return path.resolve(env.SIGMA_STATE_HOME);
  if (platform === "win32") {
    return path.resolve(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Sigma", "State");
  }
  if (platform === "darwin") {
    return path.resolve(home, "Library", "Application Support", "Sigma", "State");
  }
  return path.resolve(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "sigma");
}

function identity(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function digest(workspace: string, stateRoot: string, platform: NodeJS.Platform): string {
  return createHash("sha256")
    .update(`${identity(workspace, platform)}\0${identity(stateRoot, platform)}`)
    .digest("hex");
}

function directoryChain(target: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(target);
  while (true) {
    chain.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

async function lstatAllowMissing(directory: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function assertRealDirectory(
  directory: string,
  info: Awaited<ReturnType<typeof lstat>>
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Private state path contains an unsafe directory entry: ${directory}`);
  }
}

async function verifyPrivatePosixDirectory(directory: string, created: boolean): Promise<void> {
  if (process.platform === "win32") return;
  if (typeof process.getuid !== "function") {
    throw new Error(`Cannot verify the owner of private state directory: ${directory}`);
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    if (created) await handle.chmod(0o700);
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error(`Private state directory has unsafe ownership or permissions: ${directory}`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function lockExistingWindowsDirectories(
  directories: readonly string[],
  locks: WindowsDirectoryLock[]
): Promise<void> {
  if (process.platform !== "win32" || directories.length === 0) return;
  locks.push(await lockWindowsDirectories(directories));
}

/**
 * Creates a private state directory without traversing an existing link.
 * POSIX privacy is enforced with uid/mode checks. Node does not expose Windows
 * ACL inspection, so Windows enforcement here is limited to directory type and
 * reparse-point validation while directory handles prevent replacement.
 */
export async function ensurePrivateStateDirectory(directory: string): Promise<string> {
  const target = path.resolve(directory);
  const chain = directoryChain(target);
  const locks: WindowsDirectoryLock[] = [];
  try {
    let existingCount = 0;
    for (const candidate of chain) {
      const info = await lstatAllowMissing(candidate);
      if (!info) break;
      assertRealDirectory(candidate, info);
      existingCount += 1;
    }
    await lockExistingWindowsDirectories(chain.slice(0, existingCount), locks);

    for (const candidate of chain.slice(existingCount)) {
      let created = false;
      await mkdir(candidate, { mode: 0o700 }).then(
        () => { created = true; },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        }
      );
      const info = await lstat(candidate);
      assertRealDirectory(candidate, info);
      await lockExistingWindowsDirectories([candidate], locks);
      if (created) await verifyPrivatePosixDirectory(candidate, true);
    }

    await verifyPrivatePosixDirectory(target, false);
    for (const candidate of chain) assertRealDirectory(candidate, await lstat(candidate));
    const canonical = await realpath(target);
    assertRealDirectory(canonical, await lstat(canonical));
    await verifyPrivatePosixDirectory(canonical, false);
    return canonical;
  } finally {
    for (const lock of locks.reverse()) await lock.close().catch(() => undefined);
  }
}

async function ensurePrivateChild(parent: string, name: string): Promise<string> {
  return await ensurePrivateStateDirectory(path.join(parent, name));
}

/**
 * Resolve a durable transaction root that is outside the workspace and on the
 * same filesystem. Rename-based transactions need the latter property; state
 * homes on another volume therefore use a deterministic private sibling of the
 * canonical workspace instead.
 */
export async function workspaceTransactionRoot(
  options: WorkspaceTransactionRootOptions
): Promise<string> {
  try {
    const namespace = safeNamespace(options.namespace);
    const platform = options.platform ?? process.platform;
    const workspace = await realpath(path.resolve(options.workspacePath));
    const requestedState = path.resolve(options.stateRootDir ?? defaultStateHome(options));
    const workspaceInfo = await stat(workspace);

    let stateRoot: string | undefined;
    if (!isInside(workspace, requestedState)) {
      stateRoot = await ensurePrivateStateDirectory(requestedState);
      if (isInside(workspace, stateRoot) || (await stat(stateRoot)).dev !== workspaceInfo.dev) {
        stateRoot = undefined;
      }
    }

    const workspaceDigest = digest(workspace, requestedState, platform);
    const base = stateRoot
      ? await ensurePrivateChild(
        await ensurePrivateChild(stateRoot, "transactions"),
        workspaceDigest
      )
      : await ensurePrivateChild(
        path.dirname(workspace),
        `.sigma-transactions-${workspaceDigest.slice(0, 24)}`
      );
    const root = await ensurePrivateChild(base, namespace);
    if (isInside(workspace, root) || (await stat(root)).dev !== workspaceInfo.dev) {
      throw new Error("Could not place transaction state outside the workspace on the same filesystem.");
    }
    return root;
  } catch (error) {
    if (error instanceof WorkspaceTransactionRootError) throw error;
    throw new WorkspaceTransactionRootError(
      `Workspace transaction state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

interface DirectoryIdentity { dev: bigint; ino: bigint }

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspaceTransactionRootError(`Workspace transaction directory is unsafe: ${directory}`);
  }
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Pins transaction directories during a mutation and revalidates their path identities. */
export async function pinWorkspaceTransactionDirectories(
  requestedPaths: readonly string[]
): Promise<WorkspaceTransactionDirectoryLease> {
  const paths = [...new Set(requestedPaths.map((value) => path.resolve(value)))];
  const identities = await Promise.all(paths.map(directoryIdentity));
  const handles: Array<Awaited<ReturnType<typeof open>>> = [];
  let windowsLock: WindowsDirectoryLock | undefined;
  try {
    if (process.platform === "linux") {
      for (const [index, directory] of paths.entries()) {
        const handle = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        const current = await handle.stat({ bigint: true });
        if (!sameIdentity(identities[index]!, { dev: current.dev, ino: current.ino })) {
          await handle.close();
          throw new WorkspaceTransactionRootError(`Workspace transaction directory changed: ${directory}`);
        }
        handles.push(handle);
      }
    }
    windowsLock = await lockWindowsDirectories(paths);
    let closed = false;
    return {
      verify: async () => {
        if (closed) throw new WorkspaceTransactionRootError("Workspace transaction directory lease is closed.");
        for (const [index, directory] of paths.entries()) {
          if (!sameIdentity(identities[index]!, await directoryIdentity(directory))) {
            throw new WorkspaceTransactionRootError(`Workspace transaction directory changed: ${directory}`);
          }
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await windowsLock?.close();
        for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
      }
    };
  } catch (error) {
    await windowsLock?.close().catch(() => undefined);
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Removes only empty transaction containers owned by this resolver. */
export async function cleanupWorkspaceTransactionRoot(
  root: string
): Promise<readonly WorkspaceTransactionCleanupWarning[]> {
  const warnings: WorkspaceTransactionCleanupWarning[] = [];
  const removeEmpty = async (directory: string): Promise<boolean> => {
    try {
      await rmdir(directory);
      return true;
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      warnings.push(new WorkspaceTransactionCleanupWarning(
        directory,
        { cause: error instanceof Error ? error : undefined }
      ));
      return false;
    }
  };
  if (!await removeEmpty(root)) return warnings;
  const base = path.dirname(root);
  if (path.basename(base).startsWith(".sigma-transactions-")) {
    await removeEmpty(base);
    return warnings;
  }
  if (/^[a-f0-9]{64}$/u.test(path.basename(base)) && await removeEmpty(base)) {
    const transactions = path.dirname(base);
    if (path.basename(transactions) === "transactions") await removeEmpty(transactions);
  }
  return warnings;
}
