import type {
  ExecutionBroker,
  ExecutionResult,
  ScratchLease
} from "agent-execution";
import type {
  JsonValue,
  LoadedSkillResourceAccess,
  ToolCallPlan
} from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  executionStrings,
  executionText,
  normalizeWindowsShellInvocation,
  resolvedShell,
  shellInvocation
} from "./execution-tool-values.js";
import { loadedSkillResource } from "./execution-tool-planning.js";
import type { PlannedToolExecutionContext } from "./registry.js";

async function closeLocks(
  ...locks: Array<{ close(): Promise<void> } | undefined>
): Promise<void> {
  const failures: unknown[] = [];
  for (const lock of locks) {
    try { await lock?.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Process path-lock cleanup failed.");
  }
}

export async function closeLocksPreservingPrimary(
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
        [primary, cleanupError],
        "Process execution and path-lock cleanup failed.",
        { cause: cleanupError }
      );
    }
    const causes = primary.cause === undefined
      ? [cleanupError]
      : [primary.cause, cleanupError];
    Object.defineProperty(primary, "cause", {
      configurable: true,
      value: new AggregateError(
        causes,
        "Process path-lock cleanup failed after the primary operation error."
      )
    });
  }
}

export async function revalidateSkillResource(
  input: Record<string, JsonValue>,
  context: PlannedToolExecutionContext,
  previous: LoadedSkillResourceAccess | undefined
): Promise<LoadedSkillResourceAccess | undefined> {
  if (!previous) return undefined;
  const current = await loadedSkillResource(input, context.runtimeControl, "execute");
  const fields = [
    "qualifiedName", "relativePath", "absolutePath", "readRoot", "digest"
  ] as const;
  if (!current || fields.some((field) => current[field] !== previous[field])) {
    throw Object.assign(
      new Error("Frozen skill resource identity changed after its path lease was acquired."),
      { code: "skill_resource_stale" }
    );
  }
  return current;
}

export async function releaseRejectedResultArtifacts(
  broker: ExecutionBroker,
  result: Pick<ExecutionResult, "outputArtifacts">,
  primary: unknown
): Promise<never> {
  const ids = result.outputArtifacts?.map((artifact) => artifact.brokerArtifactId) ?? [];
  if (ids.length === 0 || !broker.releaseOutputArtifacts) throw primary;
  try {
    await broker.releaseOutputArtifacts(ids);
  } catch (cleanupError) {
    throw new AggregateError(
      [primary, cleanupError],
      "Process result rejection and artifact cleanup failed.",
      { cause: cleanupError }
    );
  }
  throw primary;
}

export function processInvocation(
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions,
  skillResource: LoadedSkillResourceAccess | undefined,
  shellCommand: boolean
): ReturnType<typeof shellInvocation> {
  if (shellCommand) {
    return shellInvocation(
      resolvedShell(input, options),
      executionText(input, "command")
    );
  }
  return normalizeWindowsShellInvocation(
    executionText(input, "executable"),
    [
      ...(skillResource ? [skillResource.absolutePath] : []),
      ...executionStrings(input, "args")
    ]
  );
}

export async function acquireScratchLease(
  options: ExecutionToolOptions,
  context: PlannedToolExecutionContext,
  approvedPlan: ToolCallPlan
): Promise<ScratchLease | undefined> {
  if (approvedPlan.mutationAuthority === "disposable_enclosing_container") {
    return undefined;
  }
  return await options.broker.acquireScratchLease?.({
    protocolVersion: 1,
    sessionId: context.sessionId
  }, { signal: context.signal });
}
