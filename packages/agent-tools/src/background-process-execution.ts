import type {
  ExecutionBroker,
  ProcessHandle,
  ProcessLifecycle,
  ProcessPollResult
} from "agent-execution";
import type {
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { resolveWorkspacePath } from "agent-platform";
import {
  processReceipt
} from "./execution-output-artifacts.js";
import {
  approvedProcessPlan,
  executionPolicy,
  loadedSkillResource,
  resolvedWriteRoots
} from "./execution-tool-planning.js";
import { simpleExecutionReceipt } from "./execution-tool-receipts.js";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  assertAvailableExecutable,
  executionArgs,
  executionEnvironment
} from "./execution-tool-values.js";
import { assertForegroundInvocation } from "./execution-foreground-schema.js";
import {
  acquireScratchLease,
  closeLocksPreservingPrimary,
  processInvocation,
  releaseRejectedResultArtifacts,
  revalidateSkillResource
} from "./execution-process-support.js";
import {
  DEFAULT_EXECUTION_YIELD_MS,
  pollProcessUntilYield,
  processYieldMs
} from "./process-wait.js";
import type { PlannedToolExecutionContext } from "./registry.js";
import { pinProcessReadRoots } from "./windows-mutation-lock.js";

async function approvedBackgroundPlan(
  input: Record<string, JsonValue>,
  context: PlannedToolExecutionContext,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  allowEnclosingContainerDeliverable: boolean
): Promise<ToolCallPlan> {
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

function requestedProcessLifecycle(
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions
): ProcessLifecycle {
  const lifecycle = input.lifecycle === "deliverable" ? "deliverable" : "session";
  if (lifecycle === "deliverable" && options.handoff !== true) {
    throw Object.assign(
      new Error("Deliverable process handoff is unavailable for this execution broker."),
      { code: "process_handoff_unavailable" }
    );
  }
  if (lifecycle === "deliverable" && input.pty === true) {
    throw Object.assign(
      new Error("Deliverable processes cannot use a PTY."),
      { code: "policy_denied" }
    );
  }
  return lifecycle;
}

interface BackgroundExecution {
  options: ExecutionToolOptions;
  request: ToolRequest;
  context: PlannedToolExecutionContext;
  input: Record<string, JsonValue>;
  lifecycle: ProcessLifecycle;
  shellCommand: boolean;
  unifiedShell: boolean;
  skillResource: LoadedSkillResourceAccess | undefined;
  approvedPlan: ToolCallPlan;
  allowEnclosingContainerDeliverable: boolean;
  startedAt: string;
}

async function spawnApprovedBackground(
  execution: BackgroundExecution,
  skillResource: LoadedSkillResourceAccess | undefined,
  approvedPlan: ToolCallPlan
): Promise<ProcessHandle> {
  const { options, context, input, lifecycle, shellCommand } = execution;
  const cwd = await resolveWorkspacePath(
    context.workspacePath,
    typeof input.cwd === "string" ? input.cwd : "."
  );
  const writeRoots = await resolvedWriteRoots(context, approvedPlan);
  const scratchLease = await acquireScratchLease(options, context, approvedPlan);
  const invocation = processInvocation(input, options, skillResource, shellCommand);
  return await options.broker.spawn({
    command: {
      ...invocation,
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
}

async function rejectFailedProcessWait(
  broker: ExecutionBroker,
  processHandle: ProcessHandle,
  error: unknown
): Promise<never> {
  let termination: ProcessPollResult;
  try {
    termination = await broker.terminate(processHandle);
  } catch (terminationError) {
    throw new AggregateError(
      [error, terminationError],
      "Background execution wait failed and the process could not be terminated.",
      { cause: terminationError }
    );
  }
  return await releaseRejectedResultArtifacts(broker, termination, error);
}

async function backgroundExecutionReceipt(
  execution: BackgroundExecution,
  processHandle: ProcessHandle,
  approvedPlan: ToolCallPlan
): Promise<ToolReceipt> {
  const { options, request, context, input, startedAt, unifiedShell } = execution;
  if (!unifiedShell) {
    return simpleExecutionReceipt(
      request, startedAt, processHandle, approvedPlan.exactEffects
    );
  }
  let result: ProcessPollResult;
  try {
    result = await pollProcessUntilYield(
      options.broker,
      processHandle,
      processYieldMs(input, DEFAULT_EXECUTION_YIELD_MS),
      context.signal,
      false
    );
  } catch (error) {
    return await rejectFailedProcessWait(options.broker, processHandle, error);
  }
  return await processReceipt(
    request,
    startedAt,
    result,
    approvedPlan.exactEffects,
    context,
    options.broker,
    "poll"
  );
}

async function executePinnedBackground(
  execution: BackgroundExecution
): Promise<ToolReceipt> {
  const {
    options, context, input, allowEnclosingContainerDeliverable
  } = execution;
  let { skillResource, approvedPlan } = execution;
  const readLock = await pinProcessReadRoots(context, approvedPlan);
  let failed = false;
  let primary: unknown;
  try {
    skillResource = await revalidateSkillResource(input, context, skillResource);
    approvedPlan = await approvedBackgroundPlan(
      input,
      context,
      options,
      skillResource,
      allowEnclosingContainerDeliverable
    );
    await readLock.verify();
    const processHandle = await spawnApprovedBackground(
      execution, skillResource, approvedPlan
    );
    return await backgroundExecutionReceipt(execution, processHandle, approvedPlan);
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await closeLocksPreservingPrimary(failed, primary, readLock);
  }
}

export async function executeBackgroundProcess(
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext,
  allowEnclosingContainerDeliverable = false,
  unifiedShell = false,
  startedAt = new Date().toISOString()
): Promise<ToolReceipt> {
  const input = executionArgs(request.arguments);
  const lifecycle = requestedProcessLifecycle(input, options);
  const invocationMode = unifiedShell
    ? assertForegroundInvocation("shell", input, options)
    : undefined;
  if (!unifiedShell) assertAvailableExecutable(input, options);
  const skillResource = await loadedSkillResource(
    input, context.runtimeControl, "execute"
  );
  const approvedPlan = await approvedBackgroundPlan(
    input, context, options, skillResource, allowEnclosingContainerDeliverable
  );
  return await executePinnedBackground({
    options,
    request,
    context,
    input,
    lifecycle,
    shellCommand: invocationMode?.shellCommand ?? false,
    unifiedShell,
    skillResource,
    approvedPlan,
    allowEnclosingContainerDeliverable,
    startedAt
  });
}
