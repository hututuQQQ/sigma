import { realpath } from "node:fs/promises";
import path from "node:path";
import type { CheckpointManager, CheckpointRecord } from "agent-checkpoint";
import type { JsonValue, RunOutcome, RunStore } from "agent-protocol";
import { readDurableChildren, type DurableChild } from "./durable-children.js";
import type { ChildCheckpointRecovery, RuntimeSession } from "./types.js";
import type { RuntimeCheckpointCoordinator } from "./runtime-checkpoint-coordinator.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { resolveOutcomeWaiters } from "./runtime-waiters.js";

function object(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : {};
}

function mutation(record: CheckpointRecord): boolean {
  const delta = record.delta;
  return Boolean(delta && delta.added.length + delta.modified.length + delta.deleted.length > 0);
}

function failedOrInterrupted(child: DurableChild): boolean {
  return !child.completed || child.completed.status !== "completed";
}

async function sameWorkspace(left: string, right: string): Promise<boolean> {
  const normalizedLeft = await realpath(path.resolve(left));
  const normalizedRight = await realpath(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function exclusiveWriterSession(
  store: RunStore,
  sessionId: string,
  parent: RuntimeSession
): Promise<boolean> {
  for await (const event of store.events(sessionId)) {
    if (event.type !== "session.created") continue;
    const payload = object(event.payload);
    return payload.mode === "change" && payload.strictWriteScope === true
      && payload.parentSessionId === parent.sessionId
      && typeof payload.workspacePath === "string"
      && await sameWorkspace(payload.workspacePath, parent.workspacePath);
  }
  return false;
}

function decisionKey(sourceSessionId: string, checkpointId: string): string {
  return `${sourceSessionId}:${checkpointId}`;
}

async function recordedDecisions(
  store: RunStore,
  parentSessionId: string
): Promise<Map<string, "restore" | "keep">> {
  const result = new Map<string, "restore" | "keep">();
  for await (const event of store.events(parentSessionId)) {
    if (event.type !== "checkpoint.recovery_resolved" || event.authority !== "user") continue;
    const payload = object(event.payload);
    if (typeof payload.sourceSessionId !== "string" || typeof payload.checkpointId !== "string") continue;
    if (payload.decision !== "restore" && payload.decision !== "keep") continue;
    result.set(decisionKey(payload.sourceSessionId, payload.checkpointId), payload.decision);
  }
  return result;
}

function alreadyImported(session: RuntimeSession, sourceSessionId: string, checkpointId: string): boolean {
  return session.state.mutationEvidence.some((item) => item.kind === "workspace_delta"
    && item.data.checkpointId === checkpointId && item.data.sourceSessionId === sourceSessionId);
}

async function latestUnresolvedMutation(
  checkpoints: CheckpointManager,
  childSessionId: string,
  session: RuntimeSession
): Promise<{ record: CheckpointRecord; currentManifestDigest: string } | null> {
  const records = [...await checkpoints.list(childSessionId)].reverse();
  for (const stored of records) {
    if (stored.status === "restored" || alreadyImported(session, childSessionId, stored.checkpointId)) continue;
    if (!await sameWorkspace(stored.workspacePath, session.workspacePath)) {
      throw Object.assign(new Error(
        `Child checkpoint ${stored.checkpointId} is outside its parent workspace.`
      ), { code: "child_checkpoint_workspace_mismatch" });
    }
    if (stored.status === "open") {
      const inspection = await checkpoints.inspectOpen(childSessionId, stored.checkpointId);
      if (inspection.changed) {
        return { record: stored, currentManifestDigest: inspection.currentManifestDigest };
      }
      const sealed = await checkpoints.seal(childSessionId, stored.checkpointId);
      if (mutation(sealed)) {
        return { record: sealed, currentManifestDigest: sealed.postManifestDigest! };
      }
      await checkpoints.undoLatest(childSessionId);
      continue;
    }
    const inspection = await checkpoints.inspectSealed(childSessionId, stored.checkpointId);
    if (!mutation(stored)) {
      if (inspection.changed) {
        throw Object.assign(new Error(
          `No-op child checkpoint ${stored.checkpointId} no longer matches its sealed postimage.`
        ), { code: "checkpoint_conflict" });
      }
      await checkpoints.undoLatest(childSessionId);
      continue;
    }
    return { record: stored, currentManifestDigest: inspection.currentManifestDigest };
  }
  return null;
}

function planNodeIds(child: DurableChild): string[] {
  const value = child.metadata.planNodeIds;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Finds failed/interrupted exclusive-workspace writers whose durable delta
 * has not been accepted or restored by the parent. Decisions are replayable:
 * a user decision that became durable before a crash is returned with the
 * recovery instead of asking the model or user to guess again. */
export async function findInterruptedChildCheckpoint(
  store: RunStore,
  checkpoints: CheckpointManager,
  session: RuntimeSession
): Promise<ChildCheckpointRecovery | null> {
  const [children, decisions] = await Promise.all([
    readDurableChildren(store, session.sessionId),
    recordedDecisions(store, session.sessionId)
  ]);
  for (const child of children.values()) {
    if (!failedOrInterrupted(child) || !child.childSessionId
      || !await exclusiveWriterSession(store, child.childSessionId, session)) continue;
    const unresolved = await latestUnresolvedMutation(checkpoints, child.childSessionId, session);
    if (!unresolved) continue;
    const key = decisionKey(child.childSessionId, unresolved.record.checkpointId);
    return {
      checkpointId: unresolved.record.checkpointId,
      currentManifestDigest: unresolved.currentManifestDigest,
      sourceSessionId: child.childSessionId,
      childId: child.childId,
      checkpointStatus: unresolved.record.status as "open" | "sealed",
      planNodeIds: planNodeIds(child),
      ...(decisions.has(key) ? { recordedDecision: decisions.get(key)! } : {})
    };
  }
  return null;
}

export function isChildCheckpointRecovery(
  value: RuntimeSession["openCheckpointRecovery"]
): value is ChildCheckpointRecovery {
  return Boolean(value && "sourceSessionId" in value);
}

export interface ChildCheckpointRecoveryCoordinatorOptions {
  store: RunStore;
  checkpoints: CheckpointManager;
  coordinator: RuntimeCheckpointCoordinator;
  control: RuntimeControlService;
  emit: RuntimeEventEmitter;
}

export class ChildCheckpointRecoveryCoordinator {
  constructor(private readonly options: ChildCheckpointRecoveryCoordinatorOptions) {}

  async recover(session: RuntimeSession): Promise<boolean> {
    while (true) {
      const recovery = await findInterruptedChildCheckpoint(
        this.options.store,
        this.options.checkpoints,
        session
      );
      if (!recovery) return false;
      session.openCheckpointRecovery = recovery;
      if (recovery.recordedDecision) {
        try {
          await this.options.coordinator.replayRecordedChildDecision(session);
          continue;
        } catch (error) {
          if ((error as { code?: unknown })?.code !== "checkpoint_conflict") throw error;
          session.openCheckpointRecovery = await this.options.control.refreshChildCheckpointRecovery(recovery);
        }
      }
      await this.suspend(session, recovery);
      return true;
    }
  }

  async suspendOwnCheckpoint(
    session: RuntimeSession,
    recovery: { checkpointId: string; currentManifestDigest: string }
  ): Promise<void> {
    session.openCheckpointRecovery = recovery;
    const message = "An interrupted mutation left a partial workspace delta. Only the user may choose safe restore or keep before continuing.";
    const outcome: RunOutcome = {
      kind: "needs_input",
      requestId: `checkpoint:${recovery.checkpointId}`,
      message
    };
    const event = await this.options.emit(session, "run.suspended", "runtime", {
      requestId: `checkpoint:${recovery.checkpointId}`,
      checkpointId: recovery.checkpointId,
      choices: ["restore", "keep"],
      message
    });
    session.lastOutcome = outcome;
    resolveOutcomeWaiters(session, event.runId, outcome);
  }

  private async suspend(session: RuntimeSession, recovery: ChildCheckpointRecovery): Promise<void> {
    const message = recovery.recordedDecision
      ? `The recorded '${recovery.recordedDecision}' decision for interrupted child '${recovery.childId}' cannot be applied because its workspace postimage changed. Resolve the conflict, then resume.`
      : `Interrupted exclusive-workspace child '${recovery.childId}' left checkpoint '${recovery.checkpointId}' changes. Only the user may choose safe restore or keep; kept changes retain validation and independent-review obligations.`;
    const outcome: RunOutcome = {
      kind: "needs_input",
      requestId: `checkpoint:${recovery.checkpointId}`,
      message
    };
    const event = await this.options.emit(session, "run.suspended", "runtime", {
      requestId: `checkpoint:${recovery.checkpointId}`,
      checkpointId: recovery.checkpointId,
      sourceSessionId: recovery.sourceSessionId,
      childId: recovery.childId,
      choices: ["restore", "keep"],
      message
    });
    session.lastOutcome = outcome;
    resolveOutcomeWaiters(session, event.runId, outcome);
  }
}
