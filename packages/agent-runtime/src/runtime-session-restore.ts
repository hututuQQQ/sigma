import { loadNestedInstructions } from "agent-context";
import type { FrozenAgentProfile } from "agent-extensions";
import type { RuntimeEnvironment } from "agent-platform";
import type { ModelGateway, RunStore } from "agent-protocol";
import { baseContext } from "./runtime-context.js";
import { restoreStoredSession } from "./restore-session.js";
import type { RuntimeSession } from "./types.js";
import { createRuntimeSessionAggregate } from "./runtime-session-state.js";

export async function hydrateRuntimeSession(
  store: RunStore,
  sessionId: string,
  runDeadlineMs: number,
  identity: {
    gateway: ModelGateway;
    profile?: FrozenAgentProfile;
    profileSource?: "home" | "workspace" | "builtin";
  },
  environment?: RuntimeEnvironment
): Promise<RuntimeSession> {
  const restored = await restoreStoredSession(store, sessionId, runDeadlineMs);
  const {
    workspacePath, state, modelTurn, lastSeq, followUps,
    writeScope, strictWriteScope, contextItems, parentSessionId, pendingApprovals
  } = restored;
  const project = await loadNestedInstructions({ workspacePath });
  const base = baseContext(environment);
  const allContext = [...base, ...project, ...contextItems];
  return createRuntimeSessionAggregate({
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    runId: state.runId,
    modelTurn,
    workspacePath,
    mode: state.mode,
    writeScope,
    strictWriteScope,
    gateway: identity.gateway,
    modelRole: restored.modelRole,
    ...(identity.profile ? { profile: identity.profile } : {}),
    ...(identity.profileSource ? { profileSource: identity.profileSource } : {}),
    state,
    seq: lastSeq,
    controller: null,
    turnController: null,
    deadlineTimer: null,
    running: null,
    subscribers: new Set(),
    approvals: new Map(pendingApprovals.map((approval) => [approval.callId, {
      effects: approval.effects,
      ...(approval.binding ? { binding: approval.binding } : {}),
      recovered: true,
      resolve: () => undefined
    }])),
    callApprovals: new Map(),
    alwaysAllowedEffects: new Set(),
    processHandles: new Map(),
    steeringPending: 0,
    followUps,
    contextItems: allContext,
    loadedContextIds: new Set(allContext.map((item) => item.id)),
    outcomeWaiters: [],
    idleWaiters: [],
    lastOutcome: state.outcome
  });
}
