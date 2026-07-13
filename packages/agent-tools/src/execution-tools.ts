import {
  SandboxUnavailableError,
  type ExecutionBroker,
  type ProcessHandle
} from "agent-execution";
import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import { commandReceipt, processReceipt } from "./execution-output-artifacts.js";
import {
  approvedProcessPlan,
  executionPolicy,
  loadedSkillResource,
  prepareExecutionCallPlan,
  resolvedWriteRoots
} from "./execution-tool-planning.js";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  assertAvailableShell,
  availableShells,
  executionArgs,
  executionEnvironment,
  executionStrings,
  executionText,
  executionToolSchema,
  normalizeWindowsShellInvocation,
  shellInvocation
} from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import { lockWindowsMutationRoots } from "./windows-mutation-lock.js";

export type { ExecutionToolOptions } from "./execution-tool-types.js";

async function executeForegroundCommand(
  kind: "exec" | "shell" | "validate",
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const input = executionArgs(request.arguments);
  const validation = kind === "validate";
  if (kind === "shell") assertAvailableShell(input, options);
  const skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
  let approvedPlan = await approvedProcessPlan(input, context, options, skillResource, validation);
  const cwd = await resolveWorkspacePath(
    context.workspacePath,
    typeof input.cwd === "string" ? input.cwd : "."
  );
  const invocation = kind === "shell"
    ? shellInvocation(executionText(input, "shell"), executionText(input, "command"))
    : normalizeWindowsShellInvocation(
      executionText(input, "executable"),
      [...(skillResource ? [skillResource.absolutePath] : []), ...executionStrings(input, "args")]
    );
  const timeoutMs = typeof input.timeoutMs === "number"
    ? Math.max(1, Math.min(600_000, input.timeoutMs)) : 600_000;
  const mutationLock = await lockWindowsMutationRoots(context, approvedPlan);
  try {
    if (mutationLock) {
      approvedPlan = await approvedProcessPlan(input, context, options, skillResource, validation);
    }
    const writeRoots = await resolvedWriteRoots(context, approvedPlan);
    const result = await options.broker.execute({
      command: { ...invocation, cwd, environment: executionEnvironment(input) },
      policy: executionPolicy(context, approvedPlan, options, writeRoots, skillResource),
      timeoutMs,
      idleTimeoutMs: Math.min(timeoutMs, 120_000)
    }, { signal: context.signal });
    return await commandReceipt(
      request,
      startedAt,
      [invocation.executable, ...invocation.args].join(" "),
      result,
      validation,
      approvedPlan.exactEffects,
      context,
      options.broker
    );
  } finally {
    await mutationLock?.close();
  }
}

function foregroundTool(kind: "exec" | "shell" | "validate", options: ExecutionToolOptions): RegisteredEffectTool {
  const validation = kind === "validate";
  const writeContractProperties: Record<string, JsonValue> = {
    access: {
      type: "string", enum: ["readonly", "write"],
      description: "Explicit process filesystem access. Defaults to readonly unless legacy writePaths is supplied."
    },
    writeRoots: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Existing sandbox ACL root directories. Required with access=write."
    },
    expectedChanges: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Exact files or narrow paths approved to change. New parent directories needed to create an approved path are implicit; other changes are rolled back."
    },
    writePaths: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Deprecated compatibility alias that supplies both sandbox/checkpoint roots and approved changes."
    }
  };
  const properties: Record<string, JsonValue> = kind === "shell" ? {
    shell: { type: "string", enum: availableShells(options) }, command: { type: "string" }, cwd: { type: "string" },
    network: { type: "string", enum: ["none", "full"] }, env: { type: "object", additionalProperties: { type: "string" } },
    ...writeContractProperties
  } : {
    executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
    skill: { type: "string", pattern: "^(home|workspace):" }, skillScript: { type: "string" },
    network: { type: "string", enum: ["none", "full"] }, env: { type: "object", additionalProperties: { type: "string" } },
    timeoutMs: { type: "number", minimum: 1, maximum: 600000 },
    ...writeContractProperties
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
      ...executionToolSchema(kind, validation
        ? "Run a sandboxed validation command and return typed evidence. With skill and skillScript, the frozen script is prepended to interpreter args."
        : `Run a sandboxed ${kind} command. With skill and skillScript, the frozen script is prepended to interpreter args.`, properties, required, effects),
      prepare(value, context) {
        if (kind === "shell") assertAvailableShell(executionArgs(value), options);
        return prepareExecutionCallPlan(value, context, options, validation);
      }
    },
    execute: async (request, context) => await executeForegroundCommand(kind, options, request, context)
  };
}

function handle(input: Record<string, JsonValue>): ProcessHandle {
  return {
    id: executionText(input, "handleId"),
    brokerInstanceId: executionText(input, "brokerInstanceId")
  };
}

function backgroundTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  const handleProperties = { handleId: { type: "string" }, brokerInstanceId: { type: "string" } };
  return [{
    descriptor: {
      ...executionToolSchema("process_spawn", "Start a sandboxed background process and return an in-session handle. With skill and skillScript, the frozen script is prepended to interpreter args.", {
        executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
        skill: { type: "string", pattern: "^(home|workspace):" }, skillScript: { type: "string" },
        network: { type: "string", enum: ["none", "full"] }, env: { type: "object", additionalProperties: { type: "string" } },
        pty: { type: "boolean" }, access: { type: "string", enum: ["readonly"] }
      }, ["executable"], ["process.spawn.readonly", "filesystem.read", "network", "open_world"]),
      prepare(value, context) { return prepareExecutionCallPlan(value, context, options, false, true); }
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = executionArgs(request.arguments);
      const skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
      const approvedPlan = await approvedProcessPlan(
        input, context, options, skillResource, false, true
      );
      const cwd = await resolveWorkspacePath(context.workspacePath, typeof input.cwd === "string" ? input.cwd : ".");
      const processHandle = await options.broker.spawn({
        command: {
          executable: executionText(input, "executable"),
          args: [...(skillResource ? [skillResource.absolutePath] : []), ...executionStrings(input, "args")],
          cwd,
          environment: executionEnvironment(input)
        },
        policy: executionPolicy(context, approvedPlan, options, [], skillResource),
        ...(input.pty === true ? { pty: true } : {})
      }, { signal: context.signal });
      return simpleReceipt(request, startedAt, processHandle, [
        "process.spawn.readonly", ...(skillResource ? ["filesystem.read" as const] : [])
      ]);
    }
  }, {
    descriptor: executionToolSchema("process_poll", "Poll incremental output from an in-session background process.", handleProperties, ["handleId", "brokerInstanceId"], ["process.spawn.readonly"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.poll(handle(executionArgs(request.arguments)), { signal: context.signal });
      return await processReceipt(request, startedAt, result, ["process.spawn.readonly"], context, options.broker);
    }
  }, {
    descriptor: executionToolSchema("process_write", "Write UTF-8 input to an in-session background process.", {
      ...handleProperties, data: { type: "string" }
    }, ["handleId", "brokerInstanceId", "data"], ["process.spawn.readonly"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = executionArgs(request.arguments);
      await options.broker.write(handle(input), executionText(input, "data"), { signal: context.signal });
      return simpleReceipt(request, startedAt, { written: true }, ["process.spawn.readonly"]);
    }
  }, {
    descriptor: executionToolSchema("process_terminate", "Terminate an in-session background process tree.", handleProperties, ["handleId", "brokerInstanceId"], ["process.spawn.readonly"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.terminate(handle(executionArgs(request.arguments)), { signal: context.signal });
      return await processReceipt(request, startedAt, result, ["process.spawn.readonly"], context, options.broker);
    }
  }];
}

function simpleReceipt(
  request: ToolRequest,
  startedAt: string,
  value: unknown,
  effects: ToolDescriptor["possibleEffects"]
): ToolReceipt {
  return {
    callId: request.callId, ok: true, output: JSON.stringify(value), observedEffects: effects, actualEffects: effects,
    artifacts: [], diagnostics: [], evidence: [], startedAt, completedAt: new Date().toISOString()
  };
}

export function unavailableExecutionBroker(message = "sigma-exec broker is not configured"): ExecutionBroker {
  const fail = async (): Promise<never> => { throw new SandboxUnavailableError(message); };
  return {
    lostProcessHandles: [], connect: fail, doctor: fail, execute: fail, spawn: fail, poll: fail,
    write: fail, terminate: fail, close: async () => undefined
  };
}

export function executionTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  return [
    foregroundTool("exec", options),
    ...(availableShells(options).length > 0 ? [foregroundTool("shell", options)] : []),
    foregroundTool("validate", options),
    ...backgroundTools(options)
  ];
}
