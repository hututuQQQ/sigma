import type { AgentEventEnvelope, JsonValue } from "agent-protocol";
import type { KernelState } from "./state.js";
import {
  recordSemanticFact,
  resolveTaskObligation,
  terminalResolutionObligation
} from "./task-control.js";
import {
  advanceCapabilityRecovery,
  capabilityRecoveryObligation
} from "./capability-task-control.js";

type Payload = Record<string, JsonValue>;
type DependencyTool = "exec" | "validate" | "process_spawn";

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function dependencyTool(value: JsonValue | undefined): DependencyTool | null {
  return value === "exec" || value === "validate" || value === "process_spawn" ? value : null;
}

function observedDependency(state: KernelState, payload: Payload): KernelState {
  const requestedExecutable = text(payload.requestedExecutable);
  const failureCode = text(payload.failureCode);
  const runtimeClosureDigest = text(payload.runtimeClosureDigest);
  const opportunityId = text(payload.opportunityId);
  const toolName = dependencyTool(payload.toolName);
  if (!requestedExecutable || !failureCode || !runtimeClosureDigest || !opportunityId || !toolName) return state;
  const fact = recordSemanticFact(state.taskControl, "runtime_environment", {
    status: "unavailable",
    requestedExecutable,
    failureCode,
    runtimeClosureDigest
  }, state.revision);
  return {
    ...state,
    taskControl: payload.recoveryAvailable === true
      ? capabilityRecoveryObligation(fact.control, state.revision, {
          opportunityId,
          requestedExecutable,
          probeToolName: toolName,
          runtimeClosureDigest
        })
      : fact.control
  };
}

function preparedDependency(state: KernelState, payload: Payload): KernelState {
  const requestedExecutable = text(payload.requestedExecutable);
  const opportunityId = text(payload.opportunityId);
  const previousRuntimeClosureDigest = text(payload.previousRuntimeClosureDigest);
  const runtimeClosureDigest = text(payload.runtimeClosureDigest);
  const obligation = state.taskControl.obligation;
  if (obligation?.kind !== "capability_recovery" || obligation.stage !== "prepare"
    || obligation.opportunityId !== opportunityId
    || obligation.requestedExecutable !== requestedExecutable
    || obligation.runtimeClosureDigest !== previousRuntimeClosureDigest
    || !runtimeClosureDigest) return state;
  const fact = recordSemanticFact(state.taskControl, "runtime_environment", {
    status: "prepared",
    requestedExecutable,
    runtimeClosureDigest
  }, state.revision);
  return {
    ...state,
    taskControl: advanceCapabilityRecovery(fact.control, state.revision, runtimeClosureDigest)
  };
}

function reprobedDependency(state: KernelState, payload: Payload): KernelState {
  const requestedExecutable = text(payload.requestedExecutable);
  const opportunityId = text(payload.opportunityId);
  const runtimeClosureDigest = text(payload.runtimeClosureDigest);
  const toolName = dependencyTool(payload.toolName);
  const obligation = state.taskControl.obligation;
  if (obligation?.kind !== "capability_recovery" || obligation.stage !== "re_probe"
    || obligation.opportunityId !== opportunityId
    || obligation.requestedExecutable !== requestedExecutable
    || obligation.probeToolName !== toolName
    || obligation.runtimeClosureDigest !== runtimeClosureDigest) return state;
  const fact = recordSemanticFact(state.taskControl, "runtime_environment", {
    status: payload.ok === true ? "available" : "unavailable_after_prepare",
    requestedExecutable,
    runtimeClosureDigest,
    failureCode: text(payload.failureCode) || null
  }, state.revision);
  return {
    ...state,
    taskControl: payload.ok === true
      ? resolveTaskObligation(fact.control)
      : terminalResolutionObligation(
          fact.control,
          state.revision,
          "capability_recovery_exhausted"
        )
  };
}

/** Apply only runtime-authority dependency facts. A tool/model-authored event
 * with the same JSON shape has no capability effect. */
export function runtimeDependencyDiagnostic(
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Payload
): KernelState | null {
  if (event.authority !== "runtime") return null;
  if (payload.kind === "runtime.dependency_observed") return observedDependency(state, payload);
  if (payload.kind === "runtime.dependency_prepared") return preparedDependency(state, payload);
  if (payload.kind === "runtime.dependency_reprobed") return reprobedDependency(state, payload);
  return null;
}
