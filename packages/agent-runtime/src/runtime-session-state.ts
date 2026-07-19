import type {
  RuntimeSession,
  RuntimeSessionDurableState,
  RuntimeSessionExecutionState,
  RuntimeSessionIdentity,
  RuntimeSessionInteractionState,
  RuntimeSessionRecoveryState,
  RuntimeSessionServices
} from "./types.js";

export type RuntimeSessionSeed = RuntimeSessionIdentity
  & RuntimeSessionDurableState
  & Omit<RuntimeSessionExecutionState, "processHandles">
  & { processHandles?: RuntimeSessionExecutionState["processHandles"] }
  & RuntimeSessionInteractionState
  & RuntimeSessionRecoveryState
  & RuntimeSessionServices;

/**
 * Stores session data in lifecycle-specific domains. Runtime modules must use
 * the domain that owns a value; the aggregate intentionally has no flat mutable
 * compatibility properties.
 */
export function createRuntimeSessionAggregate(seed: RuntimeSessionSeed): RuntimeSession {
  const identity = Object.freeze({
    sessionId: seed.sessionId,
    ...(seed.parentSessionId ? { parentSessionId: seed.parentSessionId } : {}),
    workspacePath: seed.workspacePath,
    writeScope: Object.freeze([...seed.writeScope]) as unknown as string[],
    strictWriteScope: seed.strictWriteScope,
    ...(seed.workspaceLeaseInherited ? { workspaceLeaseInherited: true } : {})
  });
  const durable = {
    runId: seed.runId,
    modelTurn: seed.modelTurn,
    mode: seed.mode,
    state: seed.state,
    seq: seed.seq,
    ...(seed.frozenCustomization ? { frozenCustomization: seed.frozenCustomization } : {})
  };
  const execution = {
    controller: seed.controller,
    turnController: seed.turnController,
    deadlineTimer: seed.deadlineTimer,
    running: seed.running,
    processHandles: seed.processHandles ?? new Map()
  };
  const interaction = {
    subscribers: seed.subscribers,
    approvals: seed.approvals,
    callApprovals: seed.callApprovals,
    alwaysAllowedEffects: seed.alwaysAllowedEffects,
    capabilityFailures: seed.capabilityFailures,
    ...(seed.validationCapabilities ? { validationCapabilities: seed.validationCapabilities } : {}),
    steeringPending: seed.steeringPending,
    followUps: seed.followUps,
    contextItems: seed.contextItems,
    loadedContextIds: seed.loadedContextIds,
    outcomeWaiters: seed.outcomeWaiters,
    idleWaiters: seed.idleWaiters
  };
  const recovery = {
    ...(seed.lastOutcome ? { lastOutcome: seed.lastOutcome } : {}),
    ...(seed.runError ? { runError: seed.runError } : {}),
    ...(seed.openCheckpointRecovery ? { openCheckpointRecovery: seed.openCheckpointRecovery } : {})
  };
  const services = {
    gateway: seed.gateway,
    modelRole: seed.modelRole,
    ...(seed.runtimeEnvironment ? { runtimeEnvironment: seed.runtimeEnvironment } : {}),
    ...(seed.profile ? { profile: seed.profile } : {}),
    ...(seed.profileSource ? { profileSource: seed.profileSource } : {})
  };
  return { identity, durable, execution, interaction, recovery, services } as RuntimeSession;
}
