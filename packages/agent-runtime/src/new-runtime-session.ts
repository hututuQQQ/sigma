import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadNestedInstructions } from "agent-context";
import { createKernelState } from "agent-kernel";
import type { StartSession } from "agent-protocol";
import { baseContext } from "./runtime-context.js";
import type { RuntimeSession } from "./types.js";

export async function newRuntimeSession(input: StartSession, runDeadlineMs: number): Promise<RuntimeSession> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const state = createKernelState({
    sessionId,
    runId,
    mode: input.mode,
    startedAt: now,
    deadlineAt: new Date(Date.now() + runDeadlineMs).toISOString()
  });
  const base = baseContext();
  const project = await loadNestedInstructions({ workspacePath: input.workspacePath });
  return {
    sessionId,
    runId,
    modelTurn: 0,
    workspacePath: path.resolve(input.workspacePath),
    mode: input.mode,
    writeScope: [...(input.writeScope ?? [])],
    strictWriteScope: input.strictWriteScope === true,
    state,
    seq: 0,
    controller: null,
    turnController: null,
    deadlineTimer: null,
    running: null,
    subscribers: new Set(),
    approvals: new Map(),
    alwaysAllowedEffects: new Set(),
    steeringPending: 0,
    followUps: [],
    contextItems: [...base, ...project],
    loadedContextIds: new Set([...base.map((item) => item.id), ...project.map((item) => item.id)]),
    outcomeWaiters: [],
    idleWaiters: []
  };
}
