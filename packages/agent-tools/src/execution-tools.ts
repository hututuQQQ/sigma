import {
  type ExecutionBroker,
  type ExecutionResult
} from "agent-execution";
import type { JsonValue, ToolReceipt, ToolRequest } from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import { commandReceipt } from "./execution-output-artifacts.js";
import { backgroundProcessTools } from "./background-process-tools.js";
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
  executionArgs,
  executionEnvironment,
  executionStrings,
  executionText,
  normalizeWindowsShellInvocation,
  resolvedShell,
  shellInvocation
} from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import {
  lockWindowsMutationRoots,
  pinProcessReadRoots
} from "./windows-mutation-lock.js";
import {
  foregroundExecutionSchema
} from "./execution-foreground-schema.js";
import { simpleExecutionReceipt } from "./execution-tool-receipts.js";
import { environmentShellTools } from "./environment-shell-tool.js";
export type { ExecutionToolOptions } from "./execution-tool-types.js";
export { unavailableExecutionBroker } from "./execution-tool-receipts.js";
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

export async function executeForegroundCommand(
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
    const scratchLease = approvedPlan.mutationAuthority === "disposable_enclosing_container_v1"
      ? undefined
      : await options.broker.acquireScratchLease?.({
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
      ...(options.writeScope === "enclosing-container"
        && options.enclosingContainerRoot === true
        ? { brokerMutationAuthority: "disposable_enclosing_container_v1" as const }
        : {}),
      prepare(value, context) {
        const input = executionArgs(value);
        if (kind === "shell" || (validation && input.shell !== undefined)) assertAvailableShell(input, options);
        return prepareExecutionCallPlan(value, context, options, validation);
      }
    },
    execute: async (request, context) => await executeForegroundCommand(kind, options, request, context)
  };
}

async function approvedBackgroundPlan(
  input: Record<string, JsonValue>,
  context: PlannedToolExecutionContext,
  options: ExecutionToolOptions,
  skillResource: Awaited<ReturnType<typeof loadedSkillResource>>,
  allowEnclosingContainerDeliverable: boolean
) {
  return await approvedProcessPlan(
    input,
    context,
    options,
    skillResource,
    false,
    true,
    allowEnclosingContainerDeliverable
  );
}

async function executeBackgroundProcess(
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext,
  allowEnclosingContainerDeliverable = false
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
  let approvedPlan = await approvedBackgroundPlan(
    input, context, options, skillResource, allowEnclosingContainerDeliverable
  );
  const readLock = await pinProcessReadRoots(context, approvedPlan);
  let failed = false;
  let primary: unknown;
  try {
    skillResource = await revalidateSkillResource(input, context, skillResource);
    approvedPlan = await approvedBackgroundPlan(
      input, context, options, skillResource, allowEnclosingContainerDeliverable
    );
    const cwd = await resolveWorkspacePath(
      context.workspacePath, typeof input.cwd === "string" ? input.cwd : "."
    );
    await readLock.verify();
    const writeRoots = await resolvedWriteRoots(context, approvedPlan);
    const scratchLease = approvedPlan.mutationAuthority === "disposable_enclosing_container_v1"
      ? undefined
      : await options.broker.acquireScratchLease?.({
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
      policy: executionPolicy(
        context,
        approvedPlan,
        options,
        writeRoots,
        skillResource,
        false,
        scratchLease
      ),
      lifecycle,
      ...(input.pty === true ? { pty: true } : {})
    }, { signal: context.signal });
    return simpleExecutionReceipt(
      request,
      startedAt,
      processHandle,
      approvedPlan.exactEffects
    );
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await closeLocksPreservingPrimary(failed, primary, readLock);
  }
}

export function executionTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  if (availableNetworkModes(options).length === 0) return [];
  return [
    ...(options.foreground === false ? [] : [
      foregroundTool("exec", options),
      ...(availableShells(options).length > 0 ? [foregroundTool("shell", options)] : []),
      foregroundTool("validate", options),
      ...environmentShellTools(options, executeForegroundCommand)
    ]),
    ...(options.background === false
      ? []
      : backgroundProcessTools(options, executeBackgroundProcess))
  ];
}
