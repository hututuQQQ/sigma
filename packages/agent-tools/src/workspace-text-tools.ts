import { replaceWorkspaceTextFile } from "./atomic-patch.js";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import type { RegisteredEffectTool } from "./registry.js";
import {
  fileIdentity,
  noChangeDiagnostic,
  probeExactTextNoChange,
  writableTarget,
  writeCheckpointScope
} from "./workspace-text-tool-support.js";
import { writeChunkTool } from "./workspace-chunk-tool.js";
import { readTool } from "./workspace-read-tool.js";

class EditPreconditionError extends Error {}

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
      description: "Write a complete UTF-8 file inside the workspace. Missing parent directories are created atomically and included in rollback. If the requested UTF-8 bytes exactly match an existing regular file, returns status=no_change without a write effect, workspace delta, or checkpoint.",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: true,
      timeoutMs: 30_000,
      async prepare(value, context) {
        const input = args(value);
        const relative = await writableTarget(context.workspacePath, stringArg(input, "path"));
        return {
          exactEffects: ["filesystem.read", "filesystem.write"],
          readPaths: [relative],
          writePaths: [relative],
          network: "none",
          processMode: "none",
          checkpointScope: await writeCheckpointScope(context.workspacePath, relative),
          idempotence: "replay_safe"
        };
      }
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
      const relative = await writableTarget(context.workspacePath, stringArg(input, "path"));
      const result = await replaceWorkspaceTextFile(context.workspacePath, relative, {
        ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {}),
        signal: context.signal,
        transform: () => stringArg(input, "content")
      });
      const identity = fileIdentity(result, relative);
      return receipt(request, startedAt, {
        output: JSON.stringify({
          status: result.changed ? "changed" : "no_change",
          path: relative,
          ...identity
        }),
        result: {
          status: result.changed ? "changed" : "no_change",
          path: relative,
          ...identity
        },
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
      const relative = await writableTarget(context.workspacePath, stringArg(input, "path"));
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
      const identity = fileIdentity(result, relative);
      const status = result.changed ? "changed" : "no_change";
      const resultIdentity = { status, path: relative, ...identity };
      return receipt(request, startedAt, {
        output: JSON.stringify(resultIdentity),
        result: resultIdentity,
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

export function workspaceTextTools(
  atomicPatchStateRootDir?: string,
  readScope: "workspace" | "host" = "host"
): RegisteredEffectTool[] {
  return [
    readTool(readScope),
    writeTool(atomicPatchStateRootDir),
    editTool(atomicPatchStateRootDir),
    writeChunkTool(atomicPatchStateRootDir)
  ];
}
