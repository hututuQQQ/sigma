import type {
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import {
  commandReceipt
} from "./execution-output-artifacts.js";
import { backgroundProcessTools } from "./background-process-tools.js";
import { executeBackgroundProcess } from "./background-process-execution.js";
import {
  approvedProcessPlan,
  executionPolicy,
  loadedSkillResource,
  prepareExecutionCallPlan,
  resolvedWriteRoots
} from "./execution-tool-planning.js";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  availableNetworkModes,
  availableShells,
  executionArgs,
  executionEnvironment,
  executionText,
} from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import {
  lockWindowsMutationRoots,
  pinProcessReadRoots
} from "./windows-mutation-lock.js";
import {
  assertForegroundInvocation,
  foregroundExecutionSchema
} from "./execution-foreground-schema.js";
import {
  acquireScratchLease,
  closeLocksPreservingPrimary,
  processInvocation,
  releaseRejectedResultArtifacts,
  revalidateSkillResource
} from "./execution-process-support.js";
import {
  environmentShellArguments,
  environmentShellAvailable
} from "./environment-shell-tool.js";
export type { ExecutionToolOptions } from "./execution-tool-types.js";
export { unavailableExecutionBroker } from "./execution-tool-receipts.js";
function networkProperty(options: ExecutionToolOptions): JsonValue {
  return {
    type: "string",
    enum: availableNetworkModes(options),
    description: `Per-call network policy; configured default is '${options.networkMode}'. none denies sockets, loopback is limited to local test services when supported, and full always requires fresh approval.`
  };
}

function foregroundArguments(
  kind: "exec" | "shell" | "validate",
  value: JsonValue,
  options: ExecutionToolOptions,
  workspacePath: string
): Record<string, JsonValue> {
  const input = executionArgs(value);
  if (kind !== "shell") return input;
  const target = input.target;
  if (target === "environment") {
    if (!environmentShellAvailable(options)) {
      throw Object.assign(new Error(
        "The broker-attested disposable outer environment is unavailable."
      ), { code: "policy_denied" });
    }
    return environmentShellArguments(
      input,
      workspacePath,
      kind === "shell" && input.validation === true
    );
  }
  if (target !== undefined && target !== "workspace") {
    throw Object.assign(new Error(
      "Shell target must be 'workspace' or 'environment'."
    ), { code: "tool_arguments_invalid" });
  }
  const { target: _target, ...workspaceInput } = input;
  return workspaceInput;
}

interface ForegroundExecution {
  options: ExecutionToolOptions;
  request: ToolRequest;
  context: PlannedToolExecutionContext;
  input: Record<string, JsonValue>;
  validation: boolean;
  shellCommand: boolean;
  skillResource: LoadedSkillResourceAccess | undefined;
  approvedPlan: ToolCallPlan;
  environmentExpectedChanges?: JsonValue;
  startedAt: string;
}

async function executePinnedForeground(
  execution: ForegroundExecution
): Promise<ToolReceipt> {
  const {
    options, request, context, input, validation, shellCommand,
    environmentExpectedChanges, startedAt
  } = execution;
  let { skillResource, approvedPlan } = execution;
  const readLock = await pinProcessReadRoots(context, approvedPlan);
  let mutationLock: Awaited<ReturnType<typeof lockWindowsMutationRoots>> = undefined;
  let failed = false;
  let primary: unknown;
  try {
    skillResource = await revalidateSkillResource(input, context, skillResource);
    approvedPlan = await approvedProcessPlan(
      input,
      context,
      options,
      skillResource,
      validation,
      false,
      false,
      environmentExpectedChanges
    );
    const cwd = await resolveWorkspacePath(
      context.workspacePath,
      typeof input.cwd === "string" ? input.cwd : "."
    );
    mutationLock = await lockWindowsMutationRoots(context, approvedPlan);
    if (mutationLock) {
      approvedPlan = await approvedProcessPlan(
        input,
        context,
        options,
        skillResource,
        validation,
        false,
        false,
        environmentExpectedChanges
      );
    }
    const writeRoots = validation ? [] : await resolvedWriteRoots(context, approvedPlan);
    await readLock.verify();
    const scratchLease = await acquireScratchLease(options, context, approvedPlan);
    const invocation = processInvocation(input, options, skillResource, shellCommand);
    const defaultTimeoutMs = Math.max(
      1,
      Math.min(600_000, Math.floor(options.commandTimeoutMs ?? 600_000))
    );
    const timeoutMs = typeof input.timeoutMs === "number"
      ? Math.max(1, Math.min(600_000, input.timeoutMs)) : defaultTimeoutMs;
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
    const command = validation && shellCommand
      ? executionText(input, "command")
      : [invocation.executable, ...invocation.args].join(" ");
    return await commandReceipt(
      request, startedAt, command, result, validation,
      approvedPlan.exactEffects, context, options.broker
    );
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await closeLocksPreservingPrimary(failed, primary, mutationLock, readLock);
  }
}

export async function executeForegroundCommand(
  kind: "exec" | "shell" | "validate",
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext,
  allowEnclosingContainerDeliverable = false,
  environmentExpectedChanges?: JsonValue
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const input = executionArgs(request.arguments);
  const invocationMode = assertForegroundInvocation(kind, input, options);
  const { shellCommand, background } = invocationMode;
  const validation = invocationMode.validation;
  if (background) {
    return await executeBackgroundProcess(
      options,
      request,
      context,
      allowEnclosingContainerDeliverable,
      true,
      startedAt,
      environmentExpectedChanges
    );
  }
  const skillResource = await loadedSkillResource(input, context.runtimeControl, "execute");
  const approvedPlan = await approvedProcessPlan(
    input,
    context,
    options,
    skillResource,
    validation,
    false,
    false,
    environmentExpectedChanges
  );
  return await executePinnedForeground({
    options,
    request,
    context,
    input,
    validation,
    shellCommand,
    skillResource,
    approvedPlan,
    environmentExpectedChanges,
    startedAt
  });
}

function foregroundTool(kind: "exec" | "shell" | "validate", options: ExecutionToolOptions): RegisteredEffectTool {
  const { schema, validation } = foregroundExecutionSchema(kind, options, networkProperty(options));
  return {
    descriptor: {
      ...schema,
      ...(options.writeScope === "enclosing-container"
        && options.enclosingContainerRoot === true
        ? { brokerMutationAuthority: "disposable_enclosing_container" as const }
        : {}),
      prepare(value, context) {
        const raw = executionArgs(value);
        const input = foregroundArguments(
          kind, value, options, context.workspacePath
        );
        const invocationMode = assertForegroundInvocation(kind, input, options);
        const allowEnclosingContainerDeliverable =
          kind === "shell" && raw.target === "environment"
          && !invocationMode.validation;
        return prepareExecutionCallPlan(
          input,
          context,
          options,
          validation || invocationMode.validation,
          invocationMode.background,
          allowEnclosingContainerDeliverable,
          allowEnclosingContainerDeliverable ? raw.expectedChanges : undefined
        );
      }
    },
    execute: async (request, context) => {
      const raw = executionArgs(request.arguments);
      const input = foregroundArguments(
        kind, request.arguments, options, context.workspacePath
      );
      const invocationMode = assertForegroundInvocation(kind, input, options);
      const allowEnclosingContainerDeliverable =
        kind === "shell" && raw.target === "environment"
        && !invocationMode.validation;
      return await executeForegroundCommand(
        kind,
        options,
        {
          ...request,
          arguments: input
        },
        context,
        allowEnclosingContainerDeliverable,
        allowEnclosingContainerDeliverable ? raw.expectedChanges : undefined
      );
    }
  };
}

export function executionTools(options: ExecutionToolOptions): RegisteredEffectTool[] {
  if (availableNetworkModes(options).length === 0) return [];
  const shellAvailable = availableShells(options).length > 0;
  return [
    ...(options.foreground === false
      ? []
      : shellAvailable
        ? [foregroundTool("shell", options)]
        : [foregroundTool("exec", options), foregroundTool("validate", options)]),
    ...(options.background === false
      ? []
      : backgroundProcessTools(options, executeBackgroundProcess))
  ];
}
