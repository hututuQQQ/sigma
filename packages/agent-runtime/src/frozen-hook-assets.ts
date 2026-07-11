import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrozenSessionCustomization, FrozenSessionHook, WorkspaceCustomizationFile } from "agent-extensions";
import { verifyFrozenWorkspaceHookTrust } from "agent-extensions";
import type { ContentAddressedArtifactStore } from "agent-store";

export interface MaterializedWorkspaceHook {
  definition: FrozenSessionHook["definition"];
  cleanup(): Promise<void>;
}

export function frozenHookExecutionRoot(storeRootDir: string): string {
  return path.join(path.resolve(storeRootDir), "hook-executions");
}

export async function persistFrozenWorkspaceHookAssets(
  workspacePath: string,
  sessionId: string,
  customization: FrozenSessionCustomization,
  putArtifact: (sessionId: string, content: Uint8Array) => Promise<string>
): Promise<void> {
  const unique = new Map<string, WorkspaceCustomizationFile>();
  for (const hook of customization.hooks) {
    if (!isFrozenWorkspaceCommand(hook)) continue;
    verifyFrozenWorkspaceHookTrust(workspacePath, hook);
    for (const asset of selectedAssets(hook)) unique.set(asset.relativePath, asset);
  }
  for (const asset of unique.values()) {
    const content = await readIdentityBoundFile(workspacePath, asset);
    const artifactId = await putArtifact(sessionId, content);
    if (artifactId !== asset.digest) {
      throw new Error(`Frozen hook asset '${asset.relativePath}' did not retain its trusted CAS identity.`);
    }
  }
}

export class FrozenWorkspaceHookMaterializer {
  private readonly executionRoot: string;

  constructor(
    storeRootDir: string,
    private readonly artifacts: ContentAddressedArtifactStore
  ) {
    this.executionRoot = frozenHookExecutionRoot(storeRootDir);
  }

  async materialize(
    workspacePath: string,
    sessionId: string,
    hook: FrozenSessionHook
  ): Promise<MaterializedWorkspaceHook> {
    if (!isFrozenWorkspaceCommand(hook) || !hook.trust) {
      return { definition: hook.definition, cleanup: async () => undefined };
    }
    const workspace = path.resolve(workspacePath);
    const invocationRoot = await this.createInvocationRoot(sessionId);
    try {
      const trustedRoots = trustedRelativeRoots(hook);
      const assets = selectedAssets(hook);
      for (const relativeRoot of trustedRoots) {
        if (!assets.some((asset) => asset.relativePath === relativeRoot)) {
          await mkdir(materializedPath(invocationRoot, relativeRoot), { recursive: true, mode: 0o700 });
        }
      }
      for (const asset of assets) {
        await this.materializeAsset(sessionId, invocationRoot, asset);
      }
      const liveCwd = path.resolve(workspace, hook.definition.cwd ?? ".");
      if (!contained(workspace, liveCwd)) throw new Error(`Frozen hook '${hook.id}' cwd escapes its workspace.`);
      const relativeCwd = workspaceRelative(workspace, liveCwd);
      const cwdIsTrusted = trustedRoots.some((root) =>
        relativeCwd === root || relativeCwd.startsWith(`${root}/`));
      const executionCwd = cwdIsTrusted ? materializedPath(invocationRoot, relativeCwd) : liveCwd;
      if (cwdIsTrusted) await mkdir(executionCwd, { recursive: true, mode: 0o700 });
      const rewrite = (value: string, command: boolean): string => {
        if (!command && value.startsWith("-")) return value;
        const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(liveCwd, value);
        if (!contained(workspace, candidate)) return value;
        const relative = workspaceRelative(workspace, candidate);
        if (trustedRoots.some((root) => relative === root || relative.startsWith(`${root}/`))) {
          return materializedPath(invocationRoot, relative);
        }
        if (path.isAbsolute(value)) {
          throw new Error(`Frozen hook '${hook.id}' references an untrusted absolute workspace asset '${value}'.`);
        }
        return value;
      };
      return {
        definition: {
          ...hook.definition,
          command: rewrite(hook.definition.command, true),
          args: hook.definition.args.map((value) => rewrite(value, false)),
          cwd: executionCwd
        },
        cleanup: async () => await rm(invocationRoot, { recursive: true, force: true })
      };
    } catch (error) {
      await rm(invocationRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async materializeAsset(
    sessionId: string,
    invocationRoot: string,
    asset: WorkspaceCustomizationFile
  ): Promise<void> {
    const content = await this.artifacts.get(sessionId, asset.digest);
    if (content.byteLength !== asset.size || sha256(content) !== asset.digest) {
      throw new Error(`Frozen hook CAS asset '${asset.relativePath}' does not match its durable trust manifest.`);
    }
    const target = materializedPath(invocationRoot, asset.relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: asset.mode });
    if (process.platform !== "win32") await chmod(target, asset.mode);
    const staged = await readFile(target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size || sha256(staged) !== asset.digest
      || (process.platform !== "win32" && (info.mode & 0o777) !== asset.mode)) {
      throw new Error(`Frozen hook asset '${asset.relativePath}' changed while it was staged for execution.`);
    }
  }

  private async createInvocationRoot(sessionId: string): Promise<string> {
    await mkdir(this.executionRoot, { recursive: true, mode: 0o700 });
    const canonicalExecutionRoot = await protectedDirectory(this.executionRoot, "hook execution root");
    const sessionRoot = path.join(
      canonicalExecutionRoot,
      createHash("sha256").update(sessionId, "utf8").digest("hex")
    );
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    const canonicalSessionRoot = await protectedDirectory(sessionRoot, "hook session execution root");
    if (!contained(canonicalExecutionRoot, canonicalSessionRoot)) {
      throw new Error("Frozen hook session execution root escapes its protected state directory.");
    }
    const invocation = await mkdtemp(path.join(canonicalSessionRoot, "invoke-"));
    if (process.platform !== "win32") await chmod(invocation, 0o700);
    const canonicalInvocation = await protectedDirectory(invocation, "hook invocation root");
    if (!contained(canonicalSessionRoot, canonicalInvocation)) {
      await rm(invocation, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("Frozen hook invocation root escapes its protected session directory.");
    }
    return canonicalInvocation;
  }
}

function isFrozenWorkspaceCommand(
  hook: FrozenSessionHook
): hook is FrozenSessionHook & { definition: Extract<FrozenSessionHook["definition"], { kind: "command" }> } {
  return hook.source === "workspace" && hook.definition.kind === "command";
}

function selectedAssets(hook: FrozenSessionHook): WorkspaceCustomizationFile[] {
  if (!isFrozenWorkspaceCommand(hook) || !hook.trust) return [];
  const roots = trustedRelativeRoots(hook);
  return hook.trust.files.filter((file) => roots.some((root) =>
    file.relativePath === root || file.relativePath.startsWith(`${root}/`)));
}

function trustedRelativeRoots(hook: FrozenSessionHook): string[] {
  if (hook.definition.kind !== "command") return [];
  return [...new Set((hook.definition.trustPaths ?? []).map((value) => normalizeRelative(value, hook.id)))];
}

function normalizeRelative(value: string, hookId: string): string {
  if (path.isAbsolute(value)) throw new Error(`Frozen hook '${hookId}' trust path must be workspace-relative.`);
  const normalized = path.normalize(value).split(path.sep).join("/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Frozen hook '${hookId}' trust path escapes its workspace.`);
  }
  return normalized;
}

async function readIdentityBoundFile(
  workspacePath: string,
  expected: WorkspaceCustomizationFile
): Promise<Buffer> {
  const workspace = await realpath(path.resolve(workspacePath));
  const candidate = materializedPath(workspace, expected.relativePath);
  const beforePath = await lstat(candidate);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw changed(expected.relativePath);
  const canonicalBefore = await realpath(candidate);
  if (!contained(workspace, canonicalBefore)) throw changed(expected.relativePath);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(candidate, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(candidate);
    const canonicalAfter = await realpath(candidate);
    if (!regularFiles(before, after, afterPath)
      || !stableFileIdentity(before, after, afterPath)
      || !stableContainedPath(workspace, canonicalBefore, canonicalAfter)
      || !matchesExpectedAsset(after, content, expected)) {
      throw changed(expected.relativePath);
    }
    return content;
  } finally {
    await handle.close();
  }
}

function materializedPath(root: string, relativePath: string): string {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!contained(path.resolve(root), candidate)) throw new Error(`Frozen hook asset path '${relativePath}' escapes its root.`);
  return candidate;
}

function workspaceRelative(workspace: string, candidate: string): string {
  return path.relative(workspace, candidate).split(path.sep).join("/");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameFile(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function regularFiles(before: Stats, after: Stats, afterPath: Stats): boolean {
  return before.isFile() && after.isFile() && afterPath.isFile() && !afterPath.isSymbolicLink();
}

function stableFileIdentity(
  before: Stats,
  after: Stats,
  afterPath: Stats
): boolean {
  return sameFile(before, after) && sameFile(after, afterPath);
}

function stableContainedPath(workspace: string, before: string, after: string): boolean {
  return samePath(before, after) && contained(workspace, after);
}

function matchesExpectedAsset(
  info: Stats,
  content: Uint8Array,
  expected: WorkspaceCustomizationFile
): boolean {
  return info.size === expected.size && (info.mode & 0o777) === expected.mode
    && content.byteLength === expected.size && sha256(content) === expected.digest;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function changed(relativePath: string): Error {
  return new Error(`Frozen hook asset '${relativePath}' changed while its trusted bytes were captured.`);
}

async function protectedDirectory(candidate: string, label: string): Promise<string> {
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Frozen ${label} is not a protected directory.`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Frozen ${label} grants access outside the current user.`);
  }
  return await realpath(candidate);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
