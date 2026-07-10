import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import { resolveWorkspacePath, runProcess, runShell, runtimeEnvironment, type ShellKind } from "agent-platform";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";
import { repositoryTools } from "./repository-tools.js";
import { registerCompletionTool } from "./completion-tool.js";

function args(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArg(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  return value;
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
    workspaceDelta: input.workspaceDelta,
    artifacts: input.artifacts ?? [],
    diagnostics: input.diagnostics ?? [],
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
      const target = await resolveWorkspacePath(context.workspacePath, relative);
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
      const target = await resolveWorkspacePath(context.workspacePath, relative);
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

function execTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "exec",
      description: "Execute an argv command without an implicit shell.",
      properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" } },
      required: ["executable"],
      possibleEffects: ["process.spawn", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:process"],
      contextPathArguments: ["cwd"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 600_000,
      idleTimeoutMs: 120_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const cwd = await resolveWorkspacePath(context.workspacePath, typeof input.cwd === "string" ? input.cwd : ".");
      const argv = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [];
      const result = await runProcess({ executable: stringArg(input, "executable"), args: argv, cwd, timeoutMs: 600_000, idleTimeoutMs: 120_000, signal: context.signal });
      return receipt(request, startedAt, {
        ok: result.exitCode === 0 && !result.timedOut && !result.cancelled,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        observedEffects: ["process.spawn"],
        diagnostics: result.timedOut ? ["process timed out"] : result.cancelled ? ["process cancelled"] : []
      });
    }
  };
}

function shellTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "shell",
      description: "Execute a command in an explicitly selected shell.",
      properties: { shell: { type: "string", enum: ["powershell", "cmd", "bash"] }, command: { type: "string" }, cwd: { type: "string" } },
      required: ["shell", "command"],
      possibleEffects: ["process.spawn", "filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:process"],
      contextPathArguments: ["cwd"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 600_000,
      idleTimeoutMs: 120_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const requestedShell = stringArg(input, "shell") as ShellKind;
      if (!["powershell", "cmd", "bash"].includes(requestedShell)) throw new Error(`Unsupported shell '${requestedShell}'.`);
      if (process.platform !== "win32" && requestedShell !== "bash") throw new Error(`${requestedShell} is only supported on Windows.`);
      const cwd = await resolveWorkspacePath(context.workspacePath, typeof input.cwd === "string" ? input.cwd : ".");
      const result = await runShell(requestedShell, stringArg(input, "command"), { cwd, timeoutMs: 600_000, idleTimeoutMs: 120_000, signal: context.signal });
      return receipt(request, startedAt, {
        ok: result.exitCode === 0 && !result.timedOut && !result.cancelled,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        observedEffects: ["process.spawn"],
        diagnostics: [`platform=${runtimeEnvironment().platform}`, `shell=${requestedShell}`]
      });
    }
  };
}

function validateTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "validate",
      description: "Run a structured validation command and return typed exit evidence. Use project-native lint, test, build, or focused checks.",
      properties: {
        executable: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number", minimum: 1, maximum: 600000 }
      },
      required: ["executable"],
      possibleEffects: ["process.spawn", "filesystem.write", "validation"],
      executionMode: "parallel",
      resourceKeys: ["workspace:validation"],
      contextPathArguments: ["cwd"],
      approval: "prompt",
      idempotent: true,
      timeoutMs: 600_000,
      idleTimeoutMs: 120_000
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const cwd = await resolveWorkspacePath(context.workspacePath, typeof input.cwd === "string" ? input.cwd : ".");
      const argv = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [];
      const timeoutMs = typeof input.timeoutMs === "number" ? Math.max(1, Math.min(600_000, input.timeoutMs)) : 600_000;
      const result = await runProcess({ executable: stringArg(input, "executable"), args: argv, cwd, timeoutMs, idleTimeoutMs: Math.min(timeoutMs, 120_000), signal: context.signal });
      return receipt(request, startedAt, {
        ok: result.exitCode === 0 && !result.timedOut && !result.cancelled,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        observedEffects: ["process.spawn", "validation"],
        diagnostics: [`exit_code=${result.exitCode}`, ...(result.timedOut ? ["validation timed out"] : []), ...(result.cancelled ? ["validation cancelled"] : [])]
      });
    }
  };
}

export function registerBuiltinTools(registry: EffectToolRegistry): EffectToolRegistry {
  for (const tool of [readTool(), writeTool(), editTool(), execTool(), shellTool(), validateTool(), ...repositoryTools()]) registry.register(tool);
  return registerCompletionTool(registry);
}
