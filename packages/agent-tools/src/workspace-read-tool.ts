import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  ToolCallPlan,
  ToolPreparationContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { isInside, textLines } from "agent-platform";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import {
  MAX_EXPLICIT_WORKSPACE_READ_BYTES,
  readStableWorkspaceTextFile
} from "./stable-workspace-read.js";

async function prepareReadPlan(
  readScope: "workspace" | "host",
  argumentsValue: JsonValue,
  context: ToolPreparationContext
): Promise<ToolCallPlan> {
  const input = args(argumentsValue);
  const requested = stringArg(input, "path");
  const workspace = await realpath(context.workspacePath);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspace, requested);
  const external = !isInside(workspace, target);
  if (external && readScope !== "host") {
    throw Object.assign(new Error(`Read path escapes the workspace: ${requested}`), {
      code: "policy_denied"
    });
  }
  return {
    exactEffects: external
      ? ["filesystem.read", "filesystem.read.external"] : ["filesystem.read"],
    readPaths: [external ? target : path.relative(workspace, target).split(path.sep).join("/") || "."],
    writePaths: [], network: "none", processMode: "none", checkpointScope: [],
    idempotence: "read_only"
  };
}

async function executeRead(
  request: ToolRequest,
  context: PlannedToolExecutionContext
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const input = args(request.arguments);
  const requested = stringArg(input, "path");
  const workspace = await realpath(context.workspacePath);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspace, requested);
  const external = !isInside(workspace, target);
  if (external && (!context.callPlan?.exactEffects.includes("filesystem.read.external")
    || context.approval?.externalReadApproved !== true)) {
    throw Object.assign(new Error(`External read lacks a fresh grant: ${requested}`), {
      code: "per_call_approval_required"
    });
  }
  const loaded = await readStableWorkspaceTextFile(
    context.workspacePath,
    requested,
    context.signal,
    { allowExternalAbsolutePath: external }
  );
  const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
  const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : 500;
  const allLines = [...textLines(loaded.content)];
  const lines = allLines.slice(offset, offset + limit);
  const output = lines.map((line) => `${line.number}: ${line.text}`).join("\n");
  const canonicalPath = external
    ? target
    : path.relative(workspace, target).split(path.sep).join("/") || ".";
  const actualStart = Math.min(offset, allLines.length);
  return receipt(request, startedAt, {
    output,
    result: {
      status: "read",
      path: requested,
      scope: external ? "external" : "workspace",
      byteLength: loaded.byteLength,
      endsWithNewline: loaded.endsWithNewline,
      sha256: loaded.sha256,
      offset,
      limit,
      returnedLines: lines.length,
      totalLines: allLines.length
    },
    observedEffects: external
      ? ["filesystem.read", "filesystem.read.external"] : ["filesystem.read"],
    evidence: [{
      evidenceId: `input-access:${request.callId}`,
      sessionId: context.sessionId,
      runId: context.runId,
      kind: "input_access",
      status: "passed",
      createdAt: new Date().toISOString(),
      producer: { authority: "tool", id: request.callId },
      summary: `Read ${external ? "external" : "workspace"} input '${canonicalPath}'.`,
      data: {
        path: canonicalPath,
        scope: external ? "external" : "workspace",
        sha256: loaded.sha256,
        byteLength: loaded.byteLength,
        selection: {
          kind: "line_range",
          start: actualStart,
          endExclusive: actualStart + lines.length,
          sha256: createHash("sha256").update(output, "utf8").digest("hex"),
          byteLength: Buffer.byteLength(output, "utf8")
        }
      }
    }]
  });
}

export function readTool(readScope: "workspace" | "host"): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "read",
      description: `Read a UTF-8 text file (maximum ${MAX_EXPLICIT_WORKSPACE_READ_BYTES} bytes). Relative paths stay inside the workspace; absolute host paths require external-read approval. The structured receipt result reports byteLength, endsWithNewline, and SHA-256.`,
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 }
      },
      required: ["path"],
      possibleEffects: ["filesystem.read"],
      maximumEffects: ["filesystem.read", "filesystem.read.external"],
      executionMode: "parallel",
      resourceKeys: [],
      contextPathArguments: ["path"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 30_000,
      async prepare(argumentsValue, context) {
        return await prepareReadPlan(readScope, argumentsValue, context);
      }
    }),
    async execute(request, context) {
      return await executeRead(request, context);
    }
  };
}
