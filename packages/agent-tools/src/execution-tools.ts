import {
  SandboxUnavailableError,
  type ExecutionBroker,
  type ExecutionResult,
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
  assertAvailableExecutable,
  assertAvailableShell,
  availableNetworkModes,
  availableShells,
  executableCapabilitySchema,
  executionArgs,
  executionEnvironment,
  executionStrings,
  executionText,
  executionToolSchema,
  normalizeWindowsShellInvocation,
  shellInvocation
} from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import {
  lockWindowsMutationRoots,
  pinProcessReadRoots
} from "./windows-mutation-lock.js";

export type { ExecutionToolOptions } from "./execution-tool-types.js";

async function closeLocks(
  ...locks: Array<{ close(): Promise<void> } | undefined>
): Promise<void> {
  const failures: unknown[] = [];
  for (const lock of locks) {
    try { await lock?.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Process path-lock cleanup failed.");
}

async function closeLocksPreservingPrimary(
  failed: boolean,
  primary: unknown,
  ...locks: Array<{ close(): Promise<void> } | undefined>
): Promise<void> {
  try {
    await closeLocks(...locks);
  } catch (cleanupError) {
    if (!failed) throw cleanupError;
    if (!(primary instanceof Error)) {
      throw new AggregateError(
        [primary, cleanupError], "Process execution and path-lock cleanup failed.", { cause: cleanupError }
      );
    }
    const causes = primary.cause === undefined
      ? [cleanupError]
      : [primary.cause, cleanupError];
    Object.defineProperty(primary, "cause", {
      configurable: true,
      value: new AggregateError(causes, "Process path-lock cleanup failed after the primary operation error.")
    });
  }
}

async function revalidateSkillResource(
  input: Record<string, JsonValue>,
  context: PlannedToolExecutionContext,
  previous: Awaited<ReturnType<typeof loadedSkillResource>>
): Promise<Awaited<ReturnType<typeof loadedSkillResource>>> {
  if (!previous) return undefined;
  const current = await loadedSkillResource(input, context.runtimeControl, "execute");
  const fields = ["qualifiedName", "relativePath", "absolutePath", "readRoot", "digest"] as const;
  if (!current || fields.some((field) => current[field] !== previous[field])) {
    throw Object.assign(new Error("Frozen skill resource identity changed after its path lease was acquired."), {
      code: "skill_resource_stale"
    });
  }
  return current;
}

async function releaseRejectedResultArtifacts(
  broker: ExecutionBroker,
  result: ExecutionResult,
  primary: unknown
): Promise<never> {
  const ids = result.outputArtifacts?.map((artifact) => artifact.brokerArtifactId) ?? [];
  if (ids.length === 0 || !broker.releaseOutputArtifacts) throw primary;
  try {
    await broker.releaseOutputArtifacts(ids);
  } catch (cleanupError) {
    throw new AggregateError(
      [primary, cleanupError], "Process result rejection and artifact cleanup failed.", { cause: cleanupError }
    );
  }
  throw primary;
}

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
  else assertAvailableExecutable(input, options);
  let skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
  let approvedPlan = await approvedProcessPlan(input, context, options, skillResource, validation);
  const invocation = kind === "shell"
    ? shellInvocation(executionText(input, "shell"), executionText(input, "command"))
    : normalizeWindowsShellInvocation(
      executionText(input, "executable"),
      [...(skillResource ? [skillResource.absolutePath] : []), ...executionStrings(input, "args")]
    );
  const timeoutMs = typeof input.timeoutMs === "number"
    ? Math.max(1, Math.min(600_000, input.timeoutMs)) : 600_000;
  const readLock = await pinProcessReadRoots(context, approvedPlan);
  let mutationLock: Awaited<ReturnType<typeof lockWindowsMutationRoots>> = undefined;
  let failed = false;
  let primary: unknown;
  try {
    skillResource = await revalidateSkillResource(input, context, skillResource);
    approvedPlan = await approvedProcessPlan(input, context, options, skillResource, validation);
    const cwd = await resolveWorkspacePath(
      context.workspacePath,
      typeof input.cwd === "string" ? input.cwd : "."
    );
    mutationLock = await lockWindowsMutationRoots(context, approvedPlan);
    if (mutationLock) approvedPlan = await approvedProcessPlan(
      input, context, options, skillResource, validation
    );
    const writeRoots = await resolvedWriteRoots(context, approvedPlan);
    await readLock.verify();
    const result = await options.broker.execute({
      command: { ...invocation, cwd, environment: executionEnvironment(input) },
      policy: executionPolicy(context, approvedPlan, options, writeRoots, skillResource),
      timeoutMs,
      idleTimeoutMs: Math.min(timeoutMs, 120_000)
    }, { signal: context.signal });
    try {
      await readLock.verify();
    } catch (error) {
      return await releaseRejectedResultArtifacts(options.broker, result, error);
    }
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
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await closeLocksPreservingPrimary(failed, primary, mutationLock, readLock);
  }
}

function foregroundTool(kind: "exec" | "shell" | "validate", options: ExecutionToolOptions): RegisteredEffectTool {
  const validation = kind === "validate";
  const writeContractProperties: Record<string, JsonValue> = {
    readRoots: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Additional stable existing workspace directories the process may read. The working directory is always included."
    },
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
    network: { type: "string", enum: availableNetworkModes(options) }, env: { type: "object", additionalProperties: { type: "string" } },
    ...writeContractProperties
  } : {
    executable: executableCapabilitySchema(options),
    args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
    skill: { type: "string", pattern: "^(home|workspace):" }, skillScript: { type: "string" },
    network: { type: "string", enum: availableNetworkModes(options) }, env: { type: "object", additionalProperties: { type: "string" } },
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

async function executeBackgroundProcess(
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const input = executionArgs(request.arguments);
  assertAvailableExecutable(input, options);
  let skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
  let approvedPlan = await approvedProcessPlan(input, context, options, skillResource, false, true);
  const readLock = await pinProcessReadRoots(context, approvedPlan);
  let failed = false;
  let primary: unknown;
  try {
    skillResource = await revalidateSkillResource(input, context, skillResource);
    approvedPlan = await approvedProcessPlan(input, context, options, skillResource, false, true);
    const cwd = await resolveWorkspacePath(
      context.workspacePath, typeof input.cwd === "string" ? input.cwd : "."
    );
    await readLock.verify();
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
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await closeLocksPreservingPrimary(failed, primary, readLock);
  }
}

function backgroundTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  const handleProperties = { handleId: { type: "string" }, brokerInstanceId: { type: "string" } };
  return [{
    descriptor: {
      ...executionToolSchema("process_spawn", "Start a sandboxed background process and return an in-session handle.", {
        executable: executableCapabilitySchema(options),
        args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
        network: { type: "string", enum: availableNetworkModes(options) },
        env: { type: "object", additionalProperties: { type: "string" } },
        ...(options.pty === false ? {} : { pty: { type: "boolean" } }),
        access: { type: "string", enum: ["readonly"] },
        readRoots: {
          type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
          description: "Additional stable existing workspace directories the process may read. The working directory is always included."
        }
      }, ["executable"], ["process.spawn.readonly", "filesystem.read", "network", "open_world"]),
      prepare(value, context) { return prepareExecutionCallPlan(value, context, options, false, true); }
    },
    async execute(request, context) { return await executeBackgroundProcess(options, request, context); }
  }, {
    descriptor: executionToolSchema("process_poll", "Poll incremental output from an in-session background process.", handleProperties, ["handleId", "brokerInstanceId"], ["process.spawn.readonly"]),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.poll(handle(executionArgs(request.arguments)), { signal: context.signal });
      return await processReceipt(request, startedAt, result, ["process.spawn.readonly"], context, options.broker);
    }
  }, ...(options.stdin === false ? [] : [{
    descriptor: executionToolSchema("process_write", "Write UTF-8 input to an in-session background process.", {
      ...handleProperties, data: { type: "string" }
    }, ["handleId", "brokerInstanceId", "data"], ["process.spawn.readonly"]),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      const input = executionArgs(request.arguments);
      await options.broker.write(handle(input), executionText(input, "data"), { signal: context.signal });
      return simpleReceipt(request, startedAt, { written: true }, ["process.spawn.readonly"]);
    }
  }]), {
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
  if (availableNetworkModes(options).length === 0) return [];
  return [
    ...(options.foreground === false ? [] : [
      foregroundTool("exec", options),
      ...(availableShells(options).length > 0 ? [foregroundTool("shell", options)] : []),
      foregroundTool("validate", options)
    ]),
    ...(options.background === false ? [] : backgroundTools(options))
  ];
}
