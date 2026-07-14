import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  DiagnosticEvidence,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { resolveWorkspacePath, textLines } from "agent-platform";
import { replaceWorkspaceTextFile } from "./atomic-patch.js";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import type { RegisteredEffectTool } from "./registry.js";
import {
  MAX_EXPLICIT_WORKSPACE_READ_BYTES,
  readStableWorkspaceTextFile,
  StableWorkspaceReadError,
  type StableWorkspaceTextRead
} from "./stable-workspace-read.js";

async function writableTarget(workspacePath: string, requestedPath: string): Promise<string> {
  const workspace = await realpath(workspacePath);
  const target = await resolveWorkspacePath(workspacePath, requestedPath);
  const segments = path.relative(workspace, target).split(path.sep).filter(Boolean);
  if (segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === ".git" || normalized === ".agent";
  })) {
    throw Object.assign(new Error(`Protected workspace metadata is read-only: ${requestedPath}`), {
      code: "protected_path"
    });
  }
  return target;
}

class EditPreconditionError extends Error {}

function readTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "read",
      description: `Read a UTF-8 text file inside the workspace (maximum ${MAX_EXPLICIT_WORKSPACE_READ_BYTES} bytes). The structured receipt result reports the original byteLength, endsWithNewline, and SHA-256 so EOF and exact-byte state are unambiguous.`,
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 }
      },
      required: ["path"],
      possibleEffects: ["filesystem.read"],
      executionMode: "parallel",
      resourceKeys: [],
      contextPathArguments: ["path"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const loaded = await readStableWorkspaceTextFile(
        context.workspacePath,
        stringArg(input, "path"),
        context.signal
      );
      const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : 500;
      const allLines = [...textLines(loaded.content)];
      const lines = allLines.slice(offset, offset + limit);
      return receipt(request, startedAt, {
        output: lines.map((line) => `${line.number}: ${line.text}`).join("\n"),
        result: {
          status: "read",
          path: stringArg(input, "path"),
          byteLength: loaded.byteLength,
          endsWithNewline: loaded.endsWithNewline,
          sha256: loaded.sha256,
          offset,
          limit,
          returnedLines: lines.length,
          totalLines: allLines.length
        },
        observedEffects: ["filesystem.read"]
      });
    }
  };
}

function missingStableRead(error: unknown): boolean {
  return error instanceof StableWorkspaceReadError
    && error.code === "workspace_read_unavailable"
    && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function noChangeDiagnostic(
  request: ToolRequest,
  context: { sessionId: string; runId: string },
  source: "write" | "edit",
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

async function probeExactTextNoChange(
  request: ToolRequest,
  context: { workspacePath: string; sessionId: string; runId: string; signal: AbortSignal },
  source: "write" | "edit",
  relative: string,
  transform: (content: string) => string
): Promise<ToolReceipt | undefined> {
  const startedAt = new Date().toISOString();
  const target = await writableTarget(context.workspacePath, relative);
  const loaded = await stableTextIfPresent(context.workspacePath, relative, context.signal, target);
  if (!loaded) return undefined;
  const replacement = Buffer.from(transform(loaded.content), "utf8");
  if (!loaded.bytes.equals(replacement)) return undefined;
  return receipt(request, startedAt, {
    output: JSON.stringify({ status: "no_change", path: relative }),
    result: { status: "no_change", path: relative },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    evidence: [noChangeDiagnostic(request, context, source, relative)]
  });
}

function editReplacement(content: string, oldText: string, newText: string): string {
  const first = content.indexOf(oldText);
  if (first < 0) throw new EditPreconditionError("oldText was not found");
  if (content.indexOf(oldText, first + oldText.length) >= 0) {
    throw new EditPreconditionError("oldText is not unique");
  }
  return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}

function writeTool(atomicPatchStateRootDir?: string): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "write",
      description: "Write a complete UTF-8 file inside the workspace. If the requested UTF-8 bytes exactly match an existing regular file, returns status=no_change without a write effect, workspace delta, or checkpoint.",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: true,
      timeoutMs: 30_000
    }),
    async probeNoChange(request, context) {
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      return await probeExactTextNoChange(
        request,
        context,
        "write",
        relative,
        () => stringArg(input, "content")
      );
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      await writableTarget(context.workspacePath, relative);
      const result = await replaceWorkspaceTextFile(context.workspacePath, relative, {
        ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {}),
        signal: context.signal,
        transform: () => stringArg(input, "content")
      });
      return receipt(request, startedAt, {
        output: result.changed ? `Wrote ${relative}` : JSON.stringify({ status: "no_change", path: relative }),
        result: { status: result.changed ? "changed" : "no_change", path: relative },
        observedEffects: result.changed
          ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
        actualEffects: result.changed
          ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
        workspaceDelta: result.changed ? result.delta : undefined,
        evidence: result.changed ? [] : [noChangeDiagnostic(request, context, "write", relative)],
        diagnostics: result.cleanupWarning ? ["atomic_cleanup_pending"] : []
      });
    }
  };
}

function editTool(atomicPatchStateRootDir?: string): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "edit",
      description: "Replace one exact text occurrence in a workspace file. If the resulting UTF-8 bytes exactly match the current regular file, returns status=no_change without a write effect, workspace delta, or checkpoint.",
      properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
      required: ["path", "oldText", "newText"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 30_000
    }),
    async probeNoChange(request, context) {
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      try {
        return await probeExactTextNoChange(
          request,
          context,
          "edit",
          relative,
          (content) => editReplacement(
            content,
            stringArg(input, "oldText"),
            stringArg(input, "newText")
          )
        );
      } catch (error) {
        if (error instanceof EditPreconditionError) return undefined;
        throw error;
      }
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      await writableTarget(context.workspacePath, relative);
      const oldText = stringArg(input, "oldText");
      let result: Awaited<ReturnType<typeof replaceWorkspaceTextFile>>;
      try {
        result = await replaceWorkspaceTextFile(context.workspacePath, relative, {
          ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {}),
          requireExisting: true,
          signal: context.signal,
          transform: (content) => editReplacement(content, oldText, stringArg(input, "newText"))
        });
      } catch (error) {
        if (error instanceof EditPreconditionError) {
          return receipt(request, startedAt, {
            ok: false,
            output: error.message,
            observedEffects: ["filesystem.read"]
          });
        }
        throw error;
      }
      return receipt(request, startedAt, {
        output: result.changed ? `Edited ${relative}` : JSON.stringify({ status: "no_change", path: relative }),
        result: { status: result.changed ? "changed" : "no_change", path: relative },
        observedEffects: result.changed
          ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
        actualEffects: result.changed
          ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
        workspaceDelta: result.changed ? result.delta : undefined,
        evidence: result.changed ? [] : [noChangeDiagnostic(request, context, "edit", relative)],
        diagnostics: result.cleanupWarning ? ["atomic_cleanup_pending"] : []
      });
    }
  };
}

export function workspaceTextTools(atomicPatchStateRootDir?: string): RegisteredEffectTool[] {
  return [readTool(), writeTool(atomicPatchStateRootDir), editTool(atomicPatchStateRootDir)];
}
