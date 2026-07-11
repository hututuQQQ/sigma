import path from "node:path";
import {
  SandboxUnavailableError,
  type ExecutionBroker,
  type ExecutionPolicy,
  type ProcessHandle
} from "agent-execution";
import type {
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan,
  ToolDescriptor,
  ToolPreparationContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import { commandReceipt, processReceipt } from "./execution-output-artifacts.js";
import type { RegisteredEffectTool } from "./registry.js";

export interface ExecutionToolOptions {
  broker: ExecutionBroker;
  sandboxMode: "required" | "unsafe";
  networkMode: "none" | "full";
}

function object(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(input: Record<string, JsonValue>, key: string, fallback?: string): string {
  const value = input[key] ?? fallback;
  if (typeof value !== "string" || !value) throw new Error(`Tool argument '${key}' must be a non-empty string.`);
  return value;
}

function strings(input: Record<string, JsonValue>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Tool argument '${key}' must be a string array.`);
  return [...value] as string[];
}

function schema(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: string[],
  effects: ToolDescriptor["possibleEffects"],
  availableModes: ToolDescriptor["availableModes"] = ["analyze", "change"]
): ToolDescriptor {
  return {
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    possibleEffects: effects,
    maximumEffects: effects,
    availableModes,
    executionMode: "exclusive",
    resourceKeys: ["workspace:process"],
    approval: "prompt",
    idempotent: false,
    timeoutMs: 600_000,
    idleTimeoutMs: 120_000
  };
}

function network(input: Record<string, JsonValue>, fallback: "none" | "full"): "none" | "full" {
  const value = input.network ?? fallback;
  if (value !== "none" && value !== "full") throw new Error("network must be none or full.");
  return value;
}

function plannedEffects(
  writes: boolean,
  validation: boolean,
  networkMode: "none" | "full",
  sandboxMode: ExecutionToolOptions["sandboxMode"],
  readsSkillResource: boolean
): ToolCallPlan["exactEffects"] {
  const effects: ToolCallPlan["exactEffects"] = [writes ? "process.spawn" : "process.spawn.readonly"];
  if (readsSkillResource) effects.push("filesystem.read");
  if (writes) effects.push("filesystem.write");
  if (validation) effects.push("validation");
  if (networkMode === "full") effects.push("network");
  if (sandboxMode === "unsafe") effects.push("open_world");
  return effects;
}

function assertSafeBackgroundMode(background: boolean, sandboxMode: ExecutionToolOptions["sandboxMode"]): void {
  if (!background || sandboxMode !== "unsafe") return;
  throw Object.assign(new Error(
    "Unsafe host background processes are disabled because their lifetime cannot be covered by one sealed checkpoint."
  ), { code: "policy_denied" });
}

function skillReference(input: Record<string, JsonValue>): { qualifiedName: string; relativePath: string } | undefined {
  const qualifiedName = input.skill;
  const relativePath = input.skillScript;
  if (qualifiedName === undefined && relativePath === undefined) return undefined;
  if (typeof qualifiedName !== "string" || !/^(home|workspace):[a-z0-9][a-z0-9._-]{0,63}$/u.test(qualifiedName)
    || typeof relativePath !== "string" || !relativePath) {
    throw Object.assign(new Error("skill and skillScript must be supplied together using a qualified skill name and relative resource path."), {
      code: "skill_resource_invalid"
    });
  }
  return { qualifiedName, relativePath };
}

async function loadedSkillResource(
  input: Record<string, JsonValue>,
  runtimeControl: ToolPreparationContext["runtimeControl"],
  purpose: "plan" | "execute"
): Promise<LoadedSkillResourceAccess | undefined> {
  const reference = skillReference(input);
  if (!reference) return undefined;
  if (!runtimeControl) {
    throw Object.assign(new Error("Skill resource execution requires session-bound runtime control."), {
      code: "skill_execution_unavailable"
    });
  }
  return await runtimeControl.resolveLoadedSkillResource({ ...reference, purpose });
}

function plannedCall(
  input: Record<string, JsonValue>,
  runMode: "analyze" | "change",
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  validation = false,
  background = false
): ToolCallPlan {
  const sandboxMode = skillResource ? "required" : options.sandboxMode;
  assertSafeBackgroundMode(background, sandboxMode);
  const networkMode = network(input, options.networkMode);
  const declaredWrites = strings(input, "writePaths");
  const writes = runMode === "change" && !background
    && (declaredWrites.length > 0 || sandboxMode === "unsafe");
  const plannedWritePaths = declaredWrites.length > 0 ? declaredWrites : writes ? ["."] : [];
  return {
    exactEffects: plannedEffects(writes, validation, networkMode, sandboxMode, Boolean(skillResource)),
    readPaths: plannedReadPaths(input, skillResource),
    writePaths: plannedWritePaths,
    network: networkMode,
    processMode: plannedProcessMode(input, background),
    checkpointScope: writes ? plannedWritePaths : [],
    idempotence: validation && !writes ? "replay_safe" : "non_replayable"
  };
}

function plannedReadPaths(
  input: Record<string, JsonValue>,
  skillResource: LoadedSkillResourceAccess | undefined
): string[] {
  const paths = [typeof input.cwd === "string" ? input.cwd : "."];
  if (skillResource) paths.push(skillResource.readRoot, skillResource.absolutePath);
  return paths;
}

function plannedProcessMode(
  input: Record<string, JsonValue>,
  background: boolean
): ToolCallPlan["processMode"] {
  if (!background) return "pipe";
  return input.pty === true ? "pty" : "background";
}

async function callPlan(
  argumentsValue: JsonValue,
  context: Pick<ToolPreparationContext, "runMode" | "runtimeControl">,
  options: ExecutionToolOptions,
  validation = false,
  background = false
): Promise<ToolCallPlan> {
  const input = object(argumentsValue);
  const skillResource = await loadedSkillResource(input, context.runtimeControl, "plan");
  return plannedCall(input, context.runMode, options, skillResource, validation, background);
}

function executionPolicy(
  context: Parameters<RegisteredEffectTool["execute"]>[1],
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions,
  writeRoots: string[] = [],
  skillResource?: LoadedSkillResourceAccess
): ExecutionPolicy {
  const required = Boolean(skillResource) || context.runMode === "analyze" || options.sandboxMode === "required";
  const networkMode = network(input, options.networkMode);
  return {
    sandbox: required ? "required" : "unsafe",
    network: networkMode,
    networkApproved: networkMode === "full" && context.approval?.networkApproved === true,
    readRoots: [...new Set([
      path.resolve(context.workspacePath),
      ...(skillResource ? [path.resolve(skillResource.readRoot)] : [])
    ])],
    writeRoots: context.runMode === "change" ? writeRoots : [],
    protectedPaths: [
      path.join(context.workspacePath, ".git"),
      path.join(context.workspacePath, ".agent"),
      ...(skillResource ? [path.resolve(skillResource.readRoot)] : [])
    ],
    unsafeHostExecApproved: !required && context.approval?.unsafeHostExecApproved === true
  };
}

async function resolvedWriteRoots(
  context: Parameters<RegisteredEffectTool["execute"]>[1],
  input: Record<string, JsonValue>
): Promise<string[]> {
  if (context.runMode !== "change") return [];
  const roots = await Promise.all(strings(input, "writePaths").map(async (item) =>
    await resolveWorkspacePath(context.workspacePath, item)
  ));
  for (const root of roots) {
    const relative = path.relative(path.resolve(context.workspacePath), root);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.some((segment) => segment === ".git" || segment === ".agent")) {
      throw Object.assign(new Error("Process writePaths cannot include .git or .agent metadata."), {
        code: "policy_denied"
      });
    }
  }
  return [...new Set(roots)];
}

function environment(input: Record<string, JsonValue>): { overrides?: Record<string, string> } | undefined {
  const raw = input.env;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("env must be an object of non-secret strings.");
  const entries = Object.entries(raw);
  if (entries.some((entry) => typeof entry[1] !== "string")) throw new Error("env values must be strings.");
  return { overrides: Object.fromEntries(entries) as Record<string, string> };
}

function foregroundTool(kind: "exec" | "shell" | "validate", options: ExecutionToolOptions): RegisteredEffectTool {
  const validation = kind === "validate";
  const properties: Record<string, JsonValue> = kind === "shell" ? {
    shell: { type: "string", enum: ["powershell", "cmd", "bash"] }, command: { type: "string" }, cwd: { type: "string" },
    network: { type: "string", enum: ["none", "full"] }, env: { type: "object", additionalProperties: { type: "string" } },
    writePaths: { type: "array", items: { type: "string" } }
  } : {
    executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
    skill: { type: "string", pattern: "^(home|workspace):" }, skillScript: { type: "string" },
    network: { type: "string", enum: ["none", "full"] }, env: { type: "object", additionalProperties: { type: "string" } },
    timeoutMs: { type: "number", minimum: 1, maximum: 600000 },
    writePaths: { type: "array", items: { type: "string" } }
  };
  if (validation) {
    properties.workspaceDeltaEvidenceIds = {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true
    };
  }
  const required = kind === "shell" ? ["shell", "command"] : ["executable"];
  const effects: ToolDescriptor["possibleEffects"] = validation
    ? ["process.spawn", "process.spawn.readonly", "filesystem.read", "filesystem.write", "validation", "network", "open_world"]
    : ["process.spawn", "process.spawn.readonly", "filesystem.read", "filesystem.write", "network", "open_world"];
  return {
    descriptor: {
      ...schema(kind, validation
        ? "Run a sandboxed validation command and return typed evidence. With skill and skillScript, the frozen script is prepended to interpreter args."
        : `Run a sandboxed ${kind} command. With skill and skillScript, the frozen script is prepended to interpreter args.`, properties, required, effects),
      prepare(value, context) { return callPlan(value, context, options, validation); }
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
      const cwd = await resolveWorkspacePath(context.workspacePath, typeof input.cwd === "string" ? input.cwd : ".");
      const invocation = kind === "shell"
        ? shellInvocation(text(input, "shell"), text(input, "command"))
        : {
            executable: text(input, "executable"),
            args: [...(skillResource ? [skillResource.absolutePath] : []), ...strings(input, "args")]
          };
      const timeoutMs = typeof input.timeoutMs === "number" ? Math.max(1, Math.min(600_000, input.timeoutMs)) : 600_000;
      const writeRoots = await resolvedWriteRoots(context, input);
      const result = await options.broker.execute({
        command: { ...invocation, cwd, environment: environment(input) },
        policy: executionPolicy(context, input, options, writeRoots, skillResource),
        timeoutMs,
        idleTimeoutMs: Math.min(timeoutMs, 120_000)
      }, { signal: context.signal });
      const actualEffects = plannedCall(
        input, context.runMode, options, skillResource, validation
      ).exactEffects;
      return await commandReceipt(
        request, startedAt, [invocation.executable, ...invocation.args].join(" "), result, validation, actualEffects,
        context, options.broker
      );
    }
  };
}

function handle(input: Record<string, JsonValue>): ProcessHandle {
  return { id: text(input, "handleId"), brokerInstanceId: text(input, "brokerInstanceId") };
}

function backgroundTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  const handleProperties = { handleId: { type: "string" }, brokerInstanceId: { type: "string" } };
  return [{
    descriptor: {
      ...schema("process_spawn", "Start a sandboxed background process and return an in-session handle. With skill and skillScript, the frozen script is prepended to interpreter args.", {
        executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
        skill: { type: "string", pattern: "^(home|workspace):" }, skillScript: { type: "string" },
        network: { type: "string", enum: ["none", "full"] }, env: { type: "object", additionalProperties: { type: "string" } },
        pty: { type: "boolean" }
      }, ["executable"], ["process.spawn.readonly", "filesystem.read", "network", "open_world"]),
      prepare(value, context) { return callPlan(value, context, options, false, true); }
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
      const cwd = await resolveWorkspacePath(context.workspacePath, typeof input.cwd === "string" ? input.cwd : ".");
      const processHandle = await options.broker.spawn({
        command: {
          executable: text(input, "executable"),
          args: [...(skillResource ? [skillResource.absolutePath] : []), ...strings(input, "args")],
          cwd,
          environment: environment(input)
        },
        policy: executionPolicy(context, input, options, [], skillResource),
        ...(input.pty === true ? { pty: true } : {})
      }, { signal: context.signal });
      return simpleReceipt(request, startedAt, processHandle, [
        "process.spawn.readonly", ...(skillResource ? ["filesystem.read" as const] : [])
      ]);
    }
  }, {
    descriptor: schema("process_poll", "Poll incremental output from an in-session background process.", handleProperties, ["handleId", "brokerInstanceId"], ["process.spawn.readonly"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.poll(handle(object(request.arguments)), { signal: context.signal });
      return await processReceipt(request, startedAt, result, ["process.spawn.readonly"], context, options.broker);
    }
  }, {
    descriptor: schema("process_write", "Write UTF-8 input to an in-session background process.", {
      ...handleProperties, data: { type: "string" }
    }, ["handleId", "brokerInstanceId", "data"], ["process.spawn.readonly"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      await options.broker.write(handle(input), text(input, "data"), { signal: context.signal });
      return simpleReceipt(request, startedAt, { written: true }, ["process.spawn.readonly"]);
    }
  }, {
    descriptor: schema("process_terminate", "Terminate an in-session background process tree.", handleProperties, ["handleId", "brokerInstanceId"], ["process.spawn.readonly"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.terminate(handle(object(request.arguments)), { signal: context.signal });
      return await processReceipt(request, startedAt, result, ["process.spawn.readonly"], context, options.broker);
    }
  }];
}

function simpleReceipt(request: ToolRequest, startedAt: string, value: unknown, effects: ToolDescriptor["possibleEffects"]): ToolReceipt {
  return {
    callId: request.callId, ok: true, output: JSON.stringify(value), observedEffects: effects, actualEffects: effects,
    artifacts: [], diagnostics: [], evidence: [], startedAt, completedAt: new Date().toISOString()
  };
}

function shellInvocation(shell: string, command: string): { executable: string; args: string[] } {
  if (shell === "powershell") return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  if (shell === "cmd") return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
  if (shell === "bash") return { executable: "bash", args: ["-lc", command] };
  throw new Error(`Unsupported shell '${shell}'.`);
}

export function unavailableExecutionBroker(message = "sigma-exec broker is not configured"): ExecutionBroker {
  const fail = async (): Promise<never> => { throw new SandboxUnavailableError(message); };
  return {
    lostProcessHandles: [], connect: fail, doctor: fail, execute: fail, spawn: fail, poll: fail,
    write: fail, terminate: fail, close: async () => undefined
  };
}

export function executionTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  return [foregroundTool("exec", options), foregroundTool("shell", options), foregroundTool("validate", options), ...backgroundTools(options)];
}
