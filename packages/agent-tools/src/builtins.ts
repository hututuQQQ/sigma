import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import type { ExecutionBroker } from "agent-execution";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";
import { repositoryTools } from "./repository-tools.js";
import { registerCompletionTool } from "./completion-tool.js";
import { applyUnifiedPatch, parseUnifiedPatch } from "./atomic-patch.js";
import { registerControlTools } from "./control-tools.js";
import {
  executionTools,
  unavailableExecutionBroker,
  type ExecutionToolOptions
} from "./execution-tools.js";
import { codeIntelTool, type CodeIntelToolOptions } from "./lsp-tools.js";

function args(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArg(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  return value;
}

async function writableTarget(workspacePath: string, requestedPath: string): Promise<string> {
  const target = await resolveWorkspacePath(workspacePath, requestedPath);
  const relative = path.relative(workspacePath, target).split(path.sep);
  const root = relative[0]?.toLowerCase();
  if (root === ".git" || root === ".agent") {
    throw Object.assign(new Error(`Protected workspace metadata is read-only: ${requestedPath}`), {
      code: "protected_path"
    });
  }
  return target;
}

function descriptor(input: Omit<ToolDescriptor, "inputSchema"> & { properties: Record<string, JsonValue>; required?: string[] }): ToolDescriptor {
  return {
    ...input,
    inputSchema: {
      type: "object",
      properties: input.properties,
      ...(input.required ? { required: input.required } : {}),
      additionalProperties: false
    }
  };
}

function receipt(
  request: ToolRequest,
  startedAt: string,
  input: Partial<Omit<ToolReceipt, "callId" | "startedAt" | "completedAt">>
): ToolReceipt {
  return {
    callId: request.callId,
    ok: input.ok ?? true,
    output: input.output ?? "",
    observedEffects: input.observedEffects ?? [],
    actualEffects: input.actualEffects ?? input.observedEffects ?? [],
    workspaceDelta: input.workspaceDelta,
    artifacts: input.artifacts ?? [],
    diagnostics: input.diagnostics ?? [],
    evidence: input.evidence ?? [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function readTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "read",
      description: "Read a UTF-8 text file inside the workspace.",
      properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
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
      const target = await resolveWorkspacePath(context.workspacePath, stringArg(input, "path"));
      const content = await readFile(target, "utf8");
      const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : 500;
      const lines = content.split(/\r?\n/).slice(offset, offset + limit);
      return receipt(request, startedAt, { output: lines.map((line, index) => `${offset + index + 1}: ${line}`).join("\n"), observedEffects: ["filesystem.read"] });
    }
  };
}

function writeTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "write",
      description: "Write a complete UTF-8 file inside the workspace.",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      possibleEffects: ["filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      contextPathArguments: ["path"],
      writePathArguments: ["path"],
      approval: "prompt",
      idempotent: true,
      timeoutMs: 30_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      const target = await writableTarget(context.workspacePath, relative);
      const existed = await stat(target).then(() => true, () => false);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, stringArg(input, "content"), "utf8");
      return receipt(request, startedAt, {
        output: `Wrote ${relative}`,
        observedEffects: ["filesystem.write"],
        workspaceDelta: { added: existed ? [] : [relative], modified: existed ? [relative] : [], deleted: [] }
      });
    }
  };
}

function editTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "edit",
      description: "Replace one exact text occurrence in a workspace file.",
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
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const relative = stringArg(input, "path");
      const target = await writableTarget(context.workspacePath, relative);
      const content = await readFile(target, "utf8");
      const oldText = stringArg(input, "oldText");
      const first = content.indexOf(oldText);
      if (first < 0) return receipt(request, startedAt, { ok: false, output: "oldText was not found", observedEffects: ["filesystem.read"] });
      if (content.indexOf(oldText, first + oldText.length) >= 0) return receipt(request, startedAt, { ok: false, output: "oldText is not unique", observedEffects: ["filesystem.read"] });
      await writeFile(target, `${content.slice(0, first)}${stringArg(input, "newText")}${content.slice(first + oldText.length)}`, "utf8");
      return receipt(request, startedAt, {
        output: `Edited ${relative}`,
        observedEffects: ["filesystem.read", "filesystem.write"],
        workspaceDelta: { added: [], modified: [relative], deleted: [] }
      });
    }
  };
}

function applyPatchTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "apply_patch",
      description: "Atomically apply a unified multi-file patch inside the workspace. All hunks are preflighted; any failure leaves every file unchanged.",
      properties: {
        patch: { type: "string" },
        preimageHashes: { type: "object", additionalProperties: { type: "string" } }
      },
      required: ["patch"],
      possibleEffects: ["filesystem.read", "filesystem.write"],
      availableModes: ["change"],
      maximumEffects: ["filesystem.read", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 120_000,
      prepare(argumentsValue) {
        const input = args(argumentsValue);
        const files = parseUnifiedPatch(stringArg(input, "patch"));
        const paths = [...new Set(files.flatMap((item) => [item.oldPath, item.newPath]
          .filter((value): value is string => Boolean(value))))];
        return {
          exactEffects: ["filesystem.read", "filesystem.write"],
          readPaths: paths,
          writePaths: paths,
          network: "none",
          processMode: "none",
          checkpointScope: paths,
          idempotence: "non_replayable"
        };
      }
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const rawHashes = input.preimageHashes;
      const preimageHashes = rawHashes && typeof rawHashes === "object" && !Array.isArray(rawHashes)
        ? Object.fromEntries(Object.entries(rawHashes).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;
      const result = await applyUnifiedPatch(context.workspacePath, stringArg(input, "patch"), { preimageHashes });
      const completedAt = new Date().toISOString();
      return {
        callId: request.callId,
        ok: true,
        output: JSON.stringify(result),
        observedEffects: ["filesystem.read", "filesystem.write"],
        actualEffects: ["filesystem.read", "filesystem.write"],
        workspaceDelta: result.delta,
        artifacts: [],
        diagnostics: [],
        // The checkpoint manager emits the authoritative delta after sealing.
        evidence: [],
        startedAt,
        completedAt
      };
    }
  };
}

export interface BuiltinToolOptions extends Partial<Omit<ExecutionToolOptions, "broker">> {
  broker?: ExecutionBroker;
  codeIntel?: Omit<CodeIntelToolOptions, "broker">;
}

export function registerBuiltinTools(registry: EffectToolRegistry, options: BuiltinToolOptions = {}): EffectToolRegistry {
  const execution: ExecutionToolOptions = {
    broker: options.broker ?? unavailableExecutionBroker(),
    sandboxMode: options.sandboxMode ?? "required",
    networkMode: options.networkMode ?? "none"
  };
  const codeIntel = options.codeIntel ? [codeIntelTool({ broker: execution.broker, ...options.codeIntel })] : [];
  for (const tool of [
    readTool(), writeTool(), editTool(), applyPatchTool(),
    ...codeIntel, ...executionTools(execution), ...repositoryTools(options.broker)
  ]) registry.register(tool);
  return registerControlTools(registerCompletionTool(registry));
}
