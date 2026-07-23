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
  resolvedShell,
  shellInvocation
} from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import {
  lockWindowsMutationRoots,
  pinProcessReadRoots
} from "./windows-mutation-lock.js";
import { processHandoffTool } from "./process-handoff-tool.js";
import { foregroundExecutionSchema } from "./execution-foreground-schema.js";

export type { ExecutionToolOptions } from "./execution-tool-types.js";

function networkProperty(options: ExecutionToolOptions): JsonValue {
  return {
    type: "string",
    enum: availableNetworkModes(options),
    description: `Per-call network policy; configured default is '${options.networkMode}'. none denies sockets, loopback is limited to local test services when supported, and full always requires fresh approval.`
  };
}

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

function assertForegroundInvocation(
  kind: "exec" | "shell" | "validate",
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions
): boolean {
  const validation = kind === "validate";
  const shellCommand = kind === "shell" || (validation && input.shell !== undefined);
  if (validation) {
    const hasExecutable = input.executable !== undefined;
    const hasShell = input.shell !== undefined || input.command !== undefined;
    if (hasExecutable === hasShell || (hasShell && (input.shell === undefined || input.command === undefined))) {
      throw new Error("validate requires exactly one invocation form: {executable,args} or {shell,command}.");
    }
  }
  if (shellCommand) assertAvailableShell(input, options);
  else assertAvailableExecutable(input, options);
  return shellCommand;
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
  const shellCommand = assertForegroundInvocation(kind, input, options);
  let skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
  let approvedPlan = await approvedProcessPlan(input, context, options, skillResource, validation);
  const invocation = shellCommand
    ? shellInvocation(resolvedShell(input, options), executionText(input, "command"))
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
    const writeRoots = validation ? [] : await resolvedWriteRoots(context, approvedPlan);
    await readLock.verify();
    const scratchLease = await options.broker.acquireScratchLease?.({
      protocolVersion: 1,
      sessionId: context.sessionId
    }, { signal: context.signal });
    const result = await options.broker.execute({
      command: { ...invocation, cwd, environment: executionEnvironment(input) },
      policy: executionPolicy(
        context, approvedPlan, options, writeRoots, skillResource, validation, scratchLease
      ),
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
      validation && shellCommand
        ? executionText(input, "command")
        : [invocation.executable, ...invocation.args].join(" "),
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
  const { schema, validation } = foregroundExecutionSchema(kind, options, networkProperty(options));
  return {
    descriptor: {
      ...schema,
      prepare(value, context) {
        const input = executionArgs(value);
        if (kind === "shell" || (validation && input.shell !== undefined)) assertAvailableShell(input, options);
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
  const lifecycle = input.lifecycle === "deliverable" ? "deliverable" : "session";
  if (lifecycle === "deliverable" && options.handoff !== true) {
    throw Object.assign(new Error("Deliverable process handoff is unavailable for this execution broker."), {
      code: "process_handoff_unavailable"
    });
  }
  if (lifecycle === "deliverable" && input.pty === true) {
    throw Object.assign(new Error("Deliverable processes cannot use a PTY."), { code: "policy_denied" });
  }
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
    const scratchLease = await options.broker.acquireScratchLease?.({
      protocolVersion: 1,
      sessionId: context.sessionId
    }, { signal: context.signal });
    const processHandle = await options.broker.spawn({
      command: {
        executable: executionText(input, "executable"),
        args: [...(skillResource ? [skillResource.absolutePath] : []), ...executionStrings(input, "args")],
        cwd,
        environment: executionEnvironment(input)
      },
      policy: executionPolicy(context, approvedPlan, options, [], skillResource, false, scratchLease),
      lifecycle,
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
        network: networkProperty(options),
        env: { type: "object", additionalProperties: { type: "string" } },
        ...(options.pty === false ? {} : { pty: { type: "boolean" } }),
        ...(options.handoff === true ? {
          lifecycle: {
            type: "string", enum: ["session", "deliverable"],
            description: "Use deliverable only for a service that must survive successful task completion; verify it through a separate interface probe, then call process_handoff."
          }
        } : {}),
        access: { type: "string", enum: ["readonly"] }
      }, ["executable"], ["process.spawn.readonly", "filesystem.read", "filesystem.read.external", "network", "open_world"]),
      prepare(value, context) { return prepareExecutionCallPlan(value, context, options, false, true); }
    },
    async execute(request, context) { return await executeBackgroundProcess(options, request, context); }
  }, {
    descriptor: executionToolSchema("process_poll", "Poll incremental output from an in-session background process.", handleProperties, ["handleId", "brokerInstanceId"], ["process.spawn.readonly"]),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.poll(handle(executionArgs(request.arguments)), { signal: context.signal });
      return await processReceipt(
        request, startedAt, result, ["process.spawn.readonly"], context, options.broker, "poll"
      );
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
      return await processReceipt(
        request, startedAt, result, ["process.spawn.readonly"], context, options.broker, "terminate"
      );
    }
  }, ...(options.handoff === true ? [processHandoffTool(options, handleProperties)] : [])];
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
