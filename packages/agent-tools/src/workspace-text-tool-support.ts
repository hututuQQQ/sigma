import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  DiagnosticEvidence,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import { replaceWorkspaceTextFile } from "./atomic-patch.js";
import { receipt } from "./builtin-tool-support.js";
import {
  readStableWorkspaceTextFile,
  StableWorkspaceReadError,
  type StableWorkspaceTextRead
} from "./stable-workspace-read.js";

export async function writableTarget(
  workspacePath: string,
  requestedPath: string
): Promise<string> {
  const workspace = await realpath(workspacePath);
  const target = await resolveWorkspacePath(workspacePath, requestedPath);
  const relative = path.relative(workspace, target).split(path.sep).filter(Boolean).join("/");
  if (!relative) {
    throw Object.assign(new Error("Workspace root is not a writable file."), {
      code: "protected_path"
    });
  }
  const segments = relative.split("/");
  if (segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === ".git" || normalized === ".agent";
  })) {
    throw Object.assign(new Error(`Protected workspace metadata is read-only: ${requestedPath}`), {
      code: "protected_path"
    });
  }
  return relative;
}

export async function writeCheckpointScope(
  workspacePath: string,
  relative: string
): Promise<string[]> {
  const workspace = await realpath(workspacePath);
  const target = await resolveWorkspacePath(workspacePath, relative);
  let ancestor = path.dirname(target);
  let missingScope: string | undefined;
  while (true) {
    const state = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (state) {
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw Object.assign(new Error(`Writable parent is not a stable directory: ${relative}`), {
          code: "workspace_parent_invalid"
        });
      }
      if (!missingScope) return [relative];
      const scope = path.relative(workspace, missingScope).split(path.sep).filter(Boolean).join("/");
      if (!scope) {
        throw Object.assign(new Error(`No contained checkpoint scope for: ${relative}`), {
          code: "workspace_parent_invalid"
        });
      }
      return [scope];
    }
    missingScope = ancestor;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw Object.assign(new Error(`No existing workspace ancestor for: ${relative}`), {
        code: "workspace_parent_invalid"
      });
    }
    ancestor = parent;
  }
}

function missingStableRead(error: unknown): boolean {
  return error instanceof StableWorkspaceReadError
    && error.code === "workspace_read_unavailable"
    && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function noChangeDiagnostic(
  request: ToolRequest,
  context: { sessionId: string; runId: string },
  source: "write" | "edit" | "write_chunk",
  relative: string
): DiagnosticEvidence {
  return {
    evidenceId: `no-change:${request.callId}`,
    sessionId: context.sessionId,
    runId: context.runId,
    kind: "diagnostic",
    status: "informational",
    createdAt: new Date().toISOString(),
    producer: { authority: "tool", id: request.callId },
    summary: `${source} made no changes because '${relative}' already has the requested bytes.`,
    data: { source, diagnostic: { status: "no_change", path: relative } }
  };
}

async function stableTextIfPresent(
  workspacePath: string,
  relative: string,
  signal: AbortSignal,
  target: string
): Promise<StableWorkspaceTextRead | undefined> {
  const state = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!state) return undefined;
  if (state.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Workspace text file is too large to compare safely: ${relative}`);
  }
  try {
    return await readStableWorkspaceTextFile(workspacePath, relative, signal, {
      maxBytes: Math.max(1, Number(state.size))
    });
  } catch (error) {
    if (missingStableRead(error)) return undefined;
    throw error;
  }
}

export async function probeExactTextNoChange(
  request: ToolRequest,
  context: { workspacePath: string; sessionId: string; runId: string; signal: AbortSignal },
  source: "write" | "edit" | "write_chunk",
  relative: string,
  transform: (content: string) => string
): Promise<ToolReceipt | undefined> {
  const startedAt = new Date().toISOString();
  const normalizedRelative = await writableTarget(context.workspacePath, relative);
  const target = await resolveWorkspacePath(context.workspacePath, normalizedRelative);
  const loaded = await stableTextIfPresent(
    context.workspacePath,
    normalizedRelative,
    context.signal,
    target
  );
  if (!loaded) return undefined;
  const replacement = Buffer.from(transform(loaded.content), "utf8");
  if (!loaded.bytes.equals(replacement)) return undefined;
  const identity = {
    byteLength: loaded.bytes.byteLength,
    sha256: sha256(loaded.bytes)
  };
  return receipt(request, startedAt, {
    output: JSON.stringify({ status: "no_change", path: normalizedRelative, ...identity }),
    result: { status: "no_change", path: normalizedRelative, ...identity },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    evidence: [noChangeDiagnostic(request, context, source, normalizedRelative)]
  });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileIdentity(
  result: Awaited<ReturnType<typeof replaceWorkspaceTextFile>>,
  relative: string
): { byteLength: number; sha256: string } {
  const byteLength = result.postimageByteLengths[relative];
  const digest = result.postimageHashes[relative];
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !digest) {
    throw new Error(`Atomic write did not return a postimage identity for '${relative}'.`);
  }
  return { byteLength, sha256: digest };
}
