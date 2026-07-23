import { createHash } from "node:crypto";
import { BrokerError } from "agent-execution";
import type { ModelToolCall } from "agent-protocol";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";

type DependencyProbeTool = "exec" | "validate" | "process_spawn";

function dependencyProbeTool(name: string): DependencyProbeTool | null {
  return name === "exec" || name === "validate" || name === "process_spawn" ? name : null;
}

function executableArgument(call: ModelToolCall): string {
  const input = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, unknown> : {};
  return typeof input.executable === "string" ? input.executable : "";
}

/** Record only a typed broker launch failure as model-visible capability
 * telemetry. This does not create recovery state or constrain the next call. */
export async function recordRuntimeDependencyFailure(
  options: Pick<EffectRunnerOptions, "runtime" | "emit">,
  session: RuntimeSession,
  call: ModelToolCall,
  error: unknown
): Promise<void> {
  if (!(error instanceof BrokerError)
    || (error.code !== "executable_not_found" && error.code !== "executable_unavailable")) return;
  const toolName = dependencyProbeTool(call.name);
  const requestedExecutable = executableArgument(call);
  const binding = session.execution.managedSessionBinding;
  if (!toolName || !requestedExecutable || !binding) return;
  const opportunityId = createHash("sha256").update(JSON.stringify({
    sessionId: session.identity.sessionId,
    userTurnCount: session.durable.state.messages.filter((message) => message.role === "user").length,
    requestedExecutable,
    probeToolName: toolName,
    runtimeClosureDigest: binding.runtimeClosure.digest
  })).digest("hex");
  await options.emit(session, "diagnostic", "runtime", {
    kind: "runtime.dependency_observed",
    protocolVersion: 1,
    callId: call.id,
    toolName,
    requestedExecutable,
    failureCode: error.code,
    runtimeClosureDigest: binding.runtimeClosure.digest,
    opportunityId,
    recoveryAvailable: binding.network === "full"
      && typeof options.runtime.execution?.prepareManagedEnvironment === "function"
  });
}
