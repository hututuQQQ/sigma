import type { JsonValue } from "agent-protocol";
import { replaceWorkspaceTextFile } from "./atomic-patch.js";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import type { RegisteredEffectTool } from "./registry.js";
import {
  fileIdentity,
  noChangeDiagnostic,
  probeExactTextNoChange,
  sha256,
  writableTarget,
  writeCheckpointScope
} from "./workspace-text-tool-support.js";

function writeChunkArguments(input: Record<string, JsonValue>): {
  path: string;
  content: string;
  expectedByteLength: number;
  expectedSha256: string;
} {
  const expectedByteLength = input.expectedByteLength;
  const expectedSha256 = input.expectedSha256;
  if (!Number.isSafeInteger(expectedByteLength) || Number(expectedByteLength) < 0) {
    throw new Error("Tool argument 'expectedByteLength' must be a non-negative safe integer.");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("Tool argument 'expectedSha256' must be a lowercase SHA-256 digest.");
  }
  const content = stringArg(input, "content");
  if (content.length === 0) throw new Error("Tool argument 'content' must be non-empty.");
  return {
    path: stringArg(input, "path"),
    content,
    expectedByteLength: Number(expectedByteLength),
    expectedSha256
  };
}

function chunkTransform(
  current: string,
  expectedByteLength: number,
  expectedSha256: string,
  chunk: string
): string {
  const currentBytes = Buffer.from(current, "utf8");
  const chunkBytes = Buffer.from(chunk, "utf8");
  if (currentBytes.byteLength === expectedByteLength && sha256(currentBytes) === expectedSha256) {
    return `${current}${chunk}`;
  }
  if (currentBytes.byteLength === expectedByteLength + chunkBytes.byteLength
    && currentBytes.subarray(-chunkBytes.byteLength).equals(chunkBytes)) {
    const prefix = currentBytes.subarray(0, expectedByteLength);
    if (sha256(prefix) === expectedSha256) return current;
  }
  throw Object.assign(new Error(
    "write_chunk precondition failed: the current UTF-8 byte length/hash is neither the expected preimage nor the already-appended postimage."
  ), { code: "write_chunk_precondition_failed" });
}

export function writeChunkTool(atomicPatchStateRootDir?: string): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "write_chunk",
      description: "Atomically append one UTF-8 chunk to a workspace file. expectedByteLength and expectedSha256 identify the preimage; replaying the same chunk returns status=no_change. The receipt returns the postimage byte length and SHA-256.",
      properties: {
        path: { type: "string" },
        content: { type: "string", minLength: 1 },
        expectedByteLength: { type: "integer", minimum: 0 },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
      },
      required: ["path", "content", "expectedByteLength", "expectedSha256"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: true,
      timeoutMs: 30_000,
      async prepare(value, context) {
        const input = writeChunkArguments(args(value));
        const relative = await writableTarget(context.workspacePath, input.path);
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
      const input = writeChunkArguments(args(request.arguments));
      return await probeExactTextNoChange(
        request,
        context,
        "write_chunk",
        input.path,
        (current) => chunkTransform(
          current,
          input.expectedByteLength,
          input.expectedSha256,
          input.content
        )
      );
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = writeChunkArguments(args(request.arguments));
      const relative = await writableTarget(context.workspacePath, input.path);
      const result = await replaceWorkspaceTextFile(context.workspacePath, relative, {
        ...(atomicPatchStateRootDir ? { stateRootDir: atomicPatchStateRootDir } : {}),
        signal: context.signal,
        transform: (current) => chunkTransform(
          current,
          input.expectedByteLength,
          input.expectedSha256,
          input.content
        )
      });
      const identity = fileIdentity(result, relative);
      const status = result.changed ? "changed" : "no_change";
      return receipt(request, startedAt, {
        output: JSON.stringify({ status, path: relative, ...identity }),
        result: { status, path: relative, ...identity },
        observedEffects: result.changed
          ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
        actualEffects: result.changed
          ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
        workspaceDelta: result.changed ? result.delta : undefined,
        evidence: result.changed
          ? [] : [noChangeDiagnostic(request, context, "write_chunk", relative)],
        diagnostics: result.cleanupWarning ? ["atomic_cleanup_pending"] : []
      });
    }
  };
}
