import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadNestedInstructions } from "agent-context";
import { createKernelState } from "agent-kernel";
import type { RuntimeEnvironment } from "agent-platform";
import { createBudgetLedger, type BudgetLimits, type StartSession } from "agent-protocol";
import { normalizedAssurancePolicy } from "./assurance-policy.js";
import { baseContext } from "./runtime-context.js";
import { configuredRunDeadlineAt } from "./run-deadline.js";
import type { RuntimeSession, RuntimeSessionServices } from "./types.js";
import { createRuntimeSessionAggregate } from "./runtime-session-state.js";
import type { FrozenHarnessBuild } from "./harness-compiler.js";

export async function newRuntimeSession(
  input: StartSession,
  runDeadlineMs: number | undefined,
  budgetLimits: BudgetLimits | undefined,
  identity: RuntimeSessionServices & {
    harness: FrozenHarnessBuild;
    parentSessionId?: string;
    workspaceLeaseInherited?: boolean;
  },
  environment?: RuntimeEnvironment
): Promise<RuntimeSession> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const state = createKernelState({
    sessionId,
    runId,
    mode: input.mode,
    startedAt: now,
    deadlineAt: configuredRunDeadlineAt(runDeadlineMs),
    assurancePolicy: normalizedAssurancePolicy(
      identity.harness.assurancePolicy.resourcePolicy
    ),
    harnessRequired: true
  });
  if (budgetLimits) state.budget = createBudgetLedger(budgetLimits);
  const base = baseContext(environment, identity.harness);
  const project = await loadNestedInstructions({ workspacePath: input.workspacePath });
  return createRuntimeSessionAggregate({
    sessionId,
    ...(identity.parentSessionId ? { parentSessionId: identity.parentSessionId } : {}),
    runId,
    modelTurn: 0,
    workspacePath: path.resolve(input.workspacePath),
    mode: input.mode,
    writeScope: [...(input.writeScope ?? [])],
    strictWriteScope: input.strictWriteScope === true,
    workspaceLeaseInherited: identity.workspaceLeaseInherited === true,
    gateway: identity.gateway,
    modelRole: identity.modelRole,
    ...(identity.profile ? { profile: identity.profile } : {}),
    ...(identity.profileSource ? { profileSource: identity.profileSource } : {}),
    state,
    seq: 0,
    frozenHarness: identity.harness,
    controller: null,
    turnController: null,
    deadlineTimer: null,
    running: null,
    subscribers: new Set(),
    approvals: new Map(),
    callApprovals: new Map(),
    alwaysAllowedEffects: new Set(),
    sessionApprovalGrants: new Set(),
    processHandles: new Map(),
    steeringPending: 0,
    followUps: [],
    contextItems: [...base, ...project],
    loadedContextIds: new Set([...base.map((item) => item.id), ...project.map((item) => item.id)]),
    outcomeWaiters: [],
    idleWaiters: []
  });
}
