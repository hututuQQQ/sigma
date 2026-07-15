import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDelta } from "agent-protocol";
import {
  cleanupWorkspaceTransactionRoot,
  pinWorkspaceTransactionDirectories,
  workspaceTransactionRoot
} from "agent-platform";
import { readPatchFile, samePatchFile } from "./atomic-patch-file-state.js";
import { recoverAtomicPatchTransactions } from "./atomic-patch-journal.js";
import { AtomicPatchError, parseUnifiedPatch } from "./atomic-patch-parser.js";
import {
  patchFileHash,
  normalizePatchRelative,
  preparePatchChange,
  verifyPatchParentContainment
} from "./atomic-patch-preparation.js";
import { commitPreparedPatch, type AtomicPatchCleanupWarning } from "./atomic-patch-transaction.js";
import type { AtomicPatchMutation, PreparedPatchChange } from "./atomic-patch-types.js";
import { readStableWorkspaceTextFile } from "./stable-workspace-read.js";

export { AtomicPatchError, parseUnifiedPatch } from "./atomic-patch-parser.js";
export { AtomicPatchCleanupError, AtomicPatchRollbackError } from "./atomic-patch-transaction.js";
export { AtomicPatchRecoveryError, recoverAtomicPatchTransactions } from "./atomic-patch-journal.js";
export type { AtomicPatchMutation } from "./atomic-patch-types.js";
export interface AtomicPatchOptions {
  preimageHashes?: Record<string, string>;
  /** Durable state root. Transaction data is always kept outside the workspace. */
  stateRootDir?: string;
  /** Test/integration synchronization point; callers cannot supply this through the model tool schema. */
  beforeCommit?: () => Promise<void>;
  /** Test-only fault-injection point; callers cannot supply this through the model tool schema. */
  beforeMutation?: (operation: AtomicPatchMutation) => Promise<void>;
}

export interface AtomicTextReplaceOptions {
  requireExisting?: boolean;
  /** Durable state root. Transaction data is always kept outside the workspace. */
  stateRootDir?: string;
  signal?: AbortSignal;
  transform(content: string, exists: boolean): string;
}

export interface AtomicPatchResult {
  changed: boolean;
  files: string[];
  delta: WorkspaceDelta;
  preimageHashes: Record<string, string>;
  postimageHashes: Record<string, string>;
  cleanupWarning?: AtomicPatchCleanupWarning;
}

function uniqueTouched(changes: readonly PreparedPatchChange[]): Set<string> {
  const touched = new Set<string>();
  for (const change of changes) {
    const paths = [change.source, change.target].filter((value): value is string => Boolean(value));
    for (const item of new Set(paths)) {
      if (touched.has(item)) throw new AtomicPatchError(`Patch changes '${item}' more than once.`);
      touched.add(item);
    }
  }
  const sorted = [...touched].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.startsWith(`${sorted[index - 1]!}/`)) {
      throw new AtomicPatchError(`Patch paths overlap: '${sorted[index - 1]}' and '${sorted[index]}'.`);
    }
  }
  return touched;
}

async function assertSourceUnchanged(workspace: string, change: PreparedPatchChange): Promise<void> {
  await verifyPatchParentContainment(workspace, change.source!);
  const current = await readPatchFile(workspace, change.source);
  if (!samePatchFile(current, change.original)) {
    throw new AtomicPatchError(`Patch source changed before commit: ${change.source}`);
  }
}

async function assertTargetAbsent(workspace: string, change: PreparedPatchChange): Promise<void> {
  await verifyPatchParentContainment(workspace, change.target!);
  if ((await readPatchFile(workspace, change.target)).exists) {
    throw new AtomicPatchError(`Patch destination changed before commit: ${change.target}`);
  }
}

async function assertPreparedChangesUnchanged(
  workspace: string,
  changes: readonly PreparedPatchChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.source) await assertSourceUnchanged(workspace, change);
    if (change.target && change.target !== change.source) await assertTargetAbsent(workspace, change);
  }
}

async function assertWorkspaceRestored(
  workspace: string,
  changes: readonly PreparedPatchChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.source) await assertSourceUnchanged(workspace, change);
    if (change.target && change.target !== change.source && (await readPatchFile(workspace, change.target)).exists) {
      throw new AtomicPatchError(`Rollback left a destination in place: ${change.target}`);
    }
  }
}

async function assertInstalledChange(workspace: string, change: PreparedPatchChange): Promise<void> {
  const current = await readPatchFile(workspace, change.target);
  if (!current.exists || current.kind !== change.kind
    || !current.bytes.equals(Buffer.from(change.content!, "utf8"))) {
    throw new AtomicPatchError(`Patch postimage does not match the prepared content: ${change.target}`);
  }
  if (process.platform !== "win32" && change.kind === "file"
    && (current.mode & 0o7777) !== (change.mode! & 0o7777)) {
    throw new AtomicPatchError(`Patch postimage mode does not match: ${change.target}`);
  }
}

async function patchTransactionPath(
  workspace: string,
  stateRootDir?: string
): Promise<{ root: string; transaction: string }> {
  const root = await workspaceTransactionRoot({
    workspacePath: workspace,
    ...(stateRootDir ? { stateRootDir } : {}),
    namespace: "atomic-patch"
  });
  return { root, transaction: path.join(root, `patch-${randomUUID()}`) };
}

function summarizeChange(
  change: PreparedPatchChange,
  preimageHashes: Record<string, string>,
  delta: WorkspaceDelta
): void {
  if (change.source) preimageHashes[change.source] = patchFileHash(change.original.bytes);
  if (!change.source && change.target) delta.added.push(change.target);
  else if (change.source && !change.target) delta.deleted.push(change.source);
  else if (change.source === change.target) delta.modified.push(change.target!);
  else {
    delta.deleted.push(change.source!);
    delta.added.push(change.target!);
  }
}

async function patchResult(
  workspace: string,
  changes: readonly PreparedPatchChange[],
  touched: ReadonlySet<string>,
  cleanupWarning?: AtomicPatchCleanupWarning
): Promise<AtomicPatchResult> {
  const preimageHashes: Record<string, string> = {};
  const postimageHashes: Record<string, string> = {};
  const delta: WorkspaceDelta = { added: [], modified: [], deleted: [] };
  for (const change of changes) summarizeChange(change, preimageHashes, delta);
  for (const change of changes) {
    if (!change.target) continue;
    const actual = await readPatchFile(workspace, change.target);
    if (!actual.exists) throw new AtomicPatchError(`Patch postimage disappeared: ${change.target}`);
    postimageHashes[change.target] = patchFileHash(actual.bytes);
  }
  for (const values of [delta.added, delta.modified, delta.deleted]) values.sort();
  return {
    changed: true,
    files: [...touched].sort(), delta, preimageHashes, postimageHashes,
    ...(cleanupWarning ? { cleanupWarning } : {})
  };
}

function unchangedTextResult(relative: string, bytes: Buffer): AtomicPatchResult {
  const digest = patchFileHash(bytes);
  return {
    changed: false,
    files: [relative],
    delta: { added: [], modified: [], deleted: [] },
    preimageHashes: { [relative]: digest },
    postimageHashes: { [relative]: digest }
  };
}

async function commitChanges(
  workspace: string,
  changes: readonly PreparedPatchChange[],
  options: AtomicPatchOptions = {}
): Promise<AtomicPatchResult> {
  const touched = uniqueTouched(changes);
  const { root, transaction } = await patchTransactionPath(workspace, options.stateRootDir);
  const rootLease = await pinWorkspaceTransactionDirectories([root]);
  let result: AtomicPatchResult | undefined;
  try {
    await rootLease.verify();
    const cleanupWarning = await commitPreparedPatch({
      workspace, transaction, changes,
      beforeCommit: options.beforeCommit,
      beforeMutation: options.beforeMutation,
      validators: {
        assertAllUnchanged: async () => await assertPreparedChangesUnchanged(workspace, changes),
        assertSourceUnchanged: async (change) => await assertSourceUnchanged(workspace, change),
        assertTargetAbsent: async (change) => await assertTargetAbsent(workspace, change),
        assertInstalled: async (change) => await assertInstalledChange(workspace, change),
        assertRestored: async () => await assertWorkspaceRestored(workspace, changes)
      }
    });
    await rootLease.verify();
    result = await patchResult(workspace, changes, touched, cleanupWarning);
    return result;
  } finally {
    const failures: Error[] = [];
    await rootLease.close().catch((error: unknown) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    });
    const cleanupWarnings = await cleanupWorkspaceTransactionRoot(root).catch((error: unknown) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      return [];
    });
    failures.push(...cleanupWarnings);
    if (result && failures.length > 0) {
      const existing = result.cleanupWarning;
      result.cleanupWarning = {
        transactionPath: existing?.transactionPath ?? root,
        error: [existing?.error, ...failures.map((failure) => failure.message)].filter(Boolean).join("; ")
      };
    }
  }
}

/** Replace one UTF-8 regular file through the same journaled, path-pinned
 * transaction used by apply_patch. The transform runs against the verified
 * preimage before any mutation begins. */
export async function replaceWorkspaceTextFile(
  workspacePath: string,
  requestedPath: string,
  options: AtomicTextReplaceOptions
): Promise<AtomicPatchResult> {
  const workspace = await realpath(path.resolve(workspacePath));
  await recoverAtomicPatchTransactions(workspace, options.stateRootDir);
  const relative = await normalizePatchRelative(workspace, requestedPath);
  await verifyPatchParentContainment(workspace, relative);
  const original = await readPatchFile(workspace, relative);
  if (options.requireExisting && !original.exists) {
    throw new AtomicPatchError(`File does not exist: ${relative}`);
  }
  if (original.exists && original.kind !== "file") {
    throw new AtomicPatchError(`Text replacement requires a regular file: ${relative}`);
  }
  const content = options.transform(original.content, original.exists);
  const replacementBytes = Buffer.from(content, "utf8");
  if (original.exists && original.bytes.equals(replacementBytes)) {
    const stable = await readStableWorkspaceTextFile(
      workspace,
      relative,
      options.signal ?? new AbortController().signal,
      { maxBytes: Math.max(1, original.bytes.byteLength) }
    );
    if (stable.bytes.equals(replacementBytes)) return unchangedTextResult(relative, stable.bytes);
  }
  return await commitChanges(workspace, [{
    ...(original.exists ? { source: relative } : {}),
    target: relative,
    original,
    content,
    kind: "file",
    mode: original.mode
  }], options.stateRootDir ? { stateRootDir: options.stateRootDir } : {});
}

export async function applyUnifiedPatch(
  workspacePath: string,
  source: string,
  options: AtomicPatchOptions = {}
): Promise<AtomicPatchResult> {
  const workspace = await realpath(path.resolve(workspacePath));
  await recoverAtomicPatchTransactions(workspace, options.stateRootDir);
  const patches = parseUnifiedPatch(source);
  const changes = await Promise.all(patches.map(async (patch) =>
    await preparePatchChange(workspace, patch, options.preimageHashes ?? {})));
  return await commitChanges(workspace, changes, options);
}
