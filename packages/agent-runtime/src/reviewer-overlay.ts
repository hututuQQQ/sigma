import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeSession } from "./types.js";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pathIdentity(root: string, relative: string): Promise<unknown> {
  const target = path.resolve(root, relative);
  const info = await lstat(target).catch(() => undefined);
  if (!info) return { path: relative, kind: "missing" };
  if (info.isSymbolicLink()) {
    return {
      path: relative,
      kind: "symlink",
      target: await readlink(target),
      mode: info.mode
    };
  }
  if (info.isFile()) {
    const content = await readFile(target);
    return {
      path: relative,
      kind: "file",
      byteLength: content.byteLength,
      digest: sha256(content),
      mode: info.mode
    };
  }
  return {
    path: relative,
    kind: info.isDirectory() ? "directory" : "other",
    mode: info.mode,
    byteLength: info.size
  };
}

export async function parentWorkspaceDigest(session: RuntimeSession): Promise<string> {
  const root = session.identity.workspacePath;
  const identities: unknown[] = [];
  const visit = async (relative: string): Promise<void> => {
    const target = relative === "." ? root : path.resolve(root, relative);
    const info = await lstat(target);
    const portable = relative.split(path.sep).join("/");
    if (info.isSymbolicLink()) {
      identities.push({
        path: portable,
        kind: "symlink",
        target: await readlink(target),
        mode: info.mode,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs
      });
      return;
    }
    if (info.isFile()) {
      identities.push({
        path: portable,
        kind: "file",
        byteLength: info.size,
        mode: info.mode,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs
      });
      return;
    }
    identities.push({
      path: portable,
      kind: info.isDirectory() ? "directory" : "other",
      mode: info.mode,
      byteLength: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs
    });
    if (!info.isDirectory()) return;
    const children = await readdir(target);
    children.sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      await visit(relative === "." ? child : path.join(relative, child));
    }
  };
  await visit(".");
  for (const item of [...new Set(session.durable.state.mutationFrontier.changedPaths)].sort()) {
    identities.push({ frontierContent: await pathIdentity(root, item) });
  }
  return sha256(JSON.stringify(identities));
}

export class DisposableOverlay {
  private root?: string;
  private container?: string;

  constructor(private readonly workspace: string) {}

  async ensure(): Promise<string> {
    if (this.root) return this.root;
    const container = await mkdtemp(path.join(os.tmpdir(), "sigma-review-"));
    const root = path.join(container, "workspace");
    try {
      await cp(this.workspace, root, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE
      });
    } catch (error) {
      await rm(container, { recursive: true, force: true }).catch(() => undefined);
      throw Object.assign(new Error(
        `Disposable verification overlay could not be created: ${
          error instanceof Error ? error.message : String(error)
        }`
      ), { code: "review_overlay_unavailable", cause: error });
    }
    this.container = container;
    this.root = root;
    return root;
  }

  async close(): Promise<void> {
    const container = this.container;
    this.root = undefined;
    this.container = undefined;
    if (!container) return;
    const resolved = path.resolve(container);
    const temporaryRoot = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== temporaryRoot
      || !path.basename(resolved).startsWith("sigma-review-")) {
      throw Object.assign(new Error("Refusing to remove an invalid verification overlay path."), {
        code: "review_overlay_cleanup_denied"
      });
    }
    await rm(resolved, { recursive: true, force: true });
  }
}
