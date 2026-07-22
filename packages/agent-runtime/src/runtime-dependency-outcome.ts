import type { JsonValue, ToolReceipt } from "agent-protocol";
import type { TaskObligationV1 } from "agent-kernel";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";

export type PendingToolRequest = { callId: string; name: string; arguments: JsonValue };
type CapabilityObligation = Extract<TaskObligationV1, { kind: "capability_recovery" }>;

function objectValue(value: JsonValue | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function preparedClosureDigest(
  session: RuntimeSession,
  receipt: ToolReceipt,
  request: PendingToolRequest,
  obligation: CapabilityObligation
): string | null {
  if (obligation.stage !== "prepare" || request.name !== "environment_prepare" || !receipt.ok) return null;
  const input = objectValue(request.arguments);
  const result = objectValue(receipt.result);
  const closure = objectValue(result.runtimeClosure as JsonValue | undefined);
  if (input.requestedExecutable !== obligation.requestedExecutable
    || result.requestedExecutable !== obligation.requestedExecutable
    || result.previousRuntimeClosureDigest !== obligation.runtimeClosureDigest
    || typeof closure.digest !== "string"
    || session.execution.managedSessionBinding?.runtimeClosure.digest !== closure.digest) return null;
  return closure.digest;
}

function matchesDependencyReprobe(
  session: RuntimeSession,
  request: PendingToolRequest,
  obligation: CapabilityObligation
): boolean {
  const input = objectValue(request.arguments);
  return obligation.stage === "re_probe"
    && request.name === obligation.probeToolName
    && input.executable === obligation.requestedExecutable
    && session.execution.managedSessionBinding?.runtimeClosure.digest === obligation.runtimeClosureDigest;
}

async function emitPreparedDependency(
  emit: EffectRunnerOptions["emit"],
  session: RuntimeSession,
  receipt: ToolReceipt,
  obligation: CapabilityObligation,
  runtimeClosureDigest: string
): Promise<void> {
  await emit(session, "diagnostic", "runtime", {
    kind: "runtime.dependency_prepared",
    protocolVersion: 1,
    callId: receipt.callId,
    requestedExecutable: obligation.requestedExecutable,
    opportunityId: obligation.opportunityId,
    previousRuntimeClosureDigest: obligation.runtimeClosureDigest,
    runtimeClosureDigest
  });
}

async function emitReprobedDependency(
  emit: EffectRunnerOptions["emit"],
  session: RuntimeSession,
  receipt: ToolReceipt,
  obligation: CapabilityObligation
): Promise<void> {
  await emit(session, "diagnostic", "runtime", {
    kind: "runtime.dependency_reprobed",
    protocolVersion: 1,
    callId: receipt.callId,
    toolName: obligation.probeToolName,
    requestedExecutable: obligation.requestedExecutable,
    opportunityId: obligation.opportunityId,
    runtimeClosureDigest: obligation.runtimeClosureDigest,
    ok: receipt.ok,
    ...(receipt.ok ? {} : { failureCode: receipt.diagnostics[0] ?? "tool_failed" })
  });
}

export async function emitRuntimeDependencyOutcome(options: {
  emit: EffectRunnerOptions["emit"];
  session: RuntimeSession;
  receipt: ToolReceipt;
  request?: PendingToolRequest;
  obligation?: TaskObligationV1;
}): Promise<void> {
  const { emit, session, receipt, request, obligation } = options;
  if (!request || obligation?.kind !== "capability_recovery") return;
  const closureDigest = preparedClosureDigest(session, receipt, request, obligation);
  if (closureDigest) return await emitPreparedDependency(
    emit, session, receipt, obligation, closureDigest
  );
  if (matchesDependencyReprobe(session, request, obligation)) {
    await emitReprobedDependency(emit, session, receipt, obligation);
  }
}
