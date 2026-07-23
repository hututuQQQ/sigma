import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ProcessExecutionPort } from "agent-platform";
import type { WorkspaceRestorationEvidenceV1 } from "agent-protocol";
import type { RuntimeCheckpointControl } from "./runtime-checkpoint-control.js";
import type { RuntimeControlServiceOptions } from "./runtime-control-contracts.js";
import type { RuntimeSession } from "./types.js";

function restorationFailure(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

function assertIsolatedRestorationCall(session: RuntimeSession, callId: string): void {
  const pending = session.durable.state.pendingTools;
  if (pending.length !== 1 || pending[0]?.request.callId !== callId || !pending[0].started
    || session.durable.state.activeModelTurn) {
    restorationFailure("Restoration requires one isolated runtime-control call.", "restoration_not_quiescent");
  }
}

function assertLocalRestorationState(
  session: RuntimeSession,
  callId: string,
  manualConfirmation: boolean
): void {
  assertIsolatedRestorationCall(session, callId);
  if (session.durable.state.activeProcessIds.length > 0) {
    restorationFailure("Restoration requires all processes to be settled.", "checkpoint_processes_active");
  }
  if (session.recovery.openCheckpointRecovery || session.durable.state.checkpointHead?.status === "open") {
    restorationFailure("Restoration requires the open checkpoint to be resolved.", "checkpoint_recovery_required");
  }
  if (session.durable.state.mutationFrontier.revision === 0) {
    restorationFailure("The current run has no mutation frontier to restore.", "restoration_mutation_missing");
  }
  if (manualConfirmation && session.durable.state.mutationFrontier.repositoryStateDigest) {
    restorationFailure("Repository metadata must be restored and verified separately.", "repository_restoration_required");
  }
  if (manualConfirmation && session.durable.state.taskControl.goalEpochSource !== "steer") {
    restorationFailure("Manual restoration confirmation requires a current user steer.", "restoration_steer_required");
  }
}

export class RuntimeRestorationControl {
  constructor(
    private readonly options: RuntimeControlServiceOptions,
    private readonly checkpoints: RuntimeCheckpointControl
  ) {}

  async restoreRunChanges(
    session: RuntimeSession,
    callId: string
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    await this.assertQuiescence(session, callId, false);
    const repositoryStateDigest = await this.restoreRepositoryBaselines(session);
    const inspection = await this.checkpoints.restoreRunChanges(session);
    return await this.recordEvidence(session, inspection, true, repositoryStateDigest);
  }

  async confirmRunRestored(
    session: RuntimeSession,
    callId: string
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    await this.assertQuiescence(session, callId, true);
    const inspection = await this.checkpoints.inspectRunRestoration(session);
    if (!inspection.restored) {
      throw Object.assign(new Error("Workspace does not match the run baseline."), {
        code: "workspace_not_restored"
      });
    }
    return await this.recordEvidence(session, inspection, false);
  }

  private async assertQuiescence(
    session: RuntimeSession,
    callId: string,
    manualConfirmation: boolean
  ): Promise<void> {
    assertLocalRestorationState(session, callId, manualConfirmation);
    if (await this.options.hasActiveChildren?.(session.identity.sessionId)) {
      restorationFailure("Restoration requires all child agents to be settled.", "checkpoint_children_active");
    }
  }

  private async recordEvidence(
    session: RuntimeSession,
    inspection: import("agent-checkpoint").RunRestorationInspection,
    explicitRestore: boolean,
    repositoryStateDigest?: string
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    const frontier = session.durable.state.mutationFrontier;
    const data: WorkspaceRestorationEvidenceV1["data"] = {
      schemaVersion: 1,
      goalEpoch: session.durable.state.taskControl.goalEpoch,
      frontierRevision: frontier.revision,
      frontierStateDigest: frontier.currentStateDigest,
      baselineManifestDigest: inspection.baselineManifestDigest,
      currentManifestDigest: inspection.currentManifestDigest,
      restoredCheckpointIds: explicitRestore
        ? inspection.checkpoints.map((item) => item.checkpointId) : [],
      quiescence: {
        supersededExecutionStopped: true,
        noPendingMutations: true,
        noProcesses: true,
        noChildren: true,
        noOpenCheckpoint: true
      },
      repository: repositoryStateDigest
        ? { status: "restored", stateDigest: repositoryStateDigest }
        : { status: "unchanged" }
    };
    const evidence: WorkspaceRestorationEvidenceV1 = {
      evidenceId: randomUUID(),
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "restoration",
      status: inspection.restored ? "passed" : "failed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "workspace-restoration-v1" },
      summary: inspection.restored
        ? "The current goal epoch is quiescent and the workspace matches its run baseline."
        : "The workspace does not match its run baseline.",
      data
    };
    await this.options.emit(session, "evidence.recorded", "runtime", evidence);
    return data;
  }

  private async restoreRepositoryBaselines(session: RuntimeSession): Promise<string | undefined> {
    if (!session.durable.state.mutationFrontier.repositoryStateDigest) return undefined;
    const restore = this.options.execution?.restoreRepositoryRunBaseline;
    if (!restore) {
      restorationFailure(
        "The execution broker cannot restore the run-scoped repository baseline.",
        "repository_atomicity_unavailable"
      );
    }
    const roots = repositoryRoots(session);
    const assertions: unknown[] = [];
    let restored = 0;
    try {
      for (const repositoryRoot of roots) {
        const result = await restore.call(this.options.execution, {
          protocolVersion: 1,
          sessionId: session.identity.sessionId,
          runId: session.durable.runId,
          repositoryRoot
        }, { signal: session.execution.controller?.signal, timeoutMs: 600_000 });
        if (result.status !== "restored" || !result.semanticAssertions) {
          restorationFailure(
            "The broker did not prove repository baseline restoration.",
            "repository_state_uncertain"
          );
        }
        restored += 1;
        assertions.push(result.semanticAssertions);
      }
    } catch (error) {
      if (restored > 0) {
        throw Object.assign(new Error(
          "Repository baseline restoration was only partially confirmed.", { cause: error }
        ), { code: "repository_state_uncertain" });
      }
      throw error;
    }
    return createHash("sha256").update(JSON.stringify(assertions), "utf8").digest("hex");
  }
}

function repositoryRoots(session: RuntimeSession): string[] {
  const workspace = path.resolve(session.identity.workspacePath);
  const roots = [...new Set(session.durable.state.evidence.flatMap((evidence) => {
    if (evidence.kind !== "repository_delta" || evidence.runId !== session.durable.runId
      || evidence.status !== "passed" || !evidence.data.repositoryRoot) return [];
    return [resolveRepositoryRoot(workspace, evidence.data.repositoryRoot)];
  }))];
  if (roots.length === 0) {
    restorationFailure(
      "Repository mutation evidence does not identify a restorable broker baseline.",
      "repository_restoration_required"
    );
  }
  return roots;
}

export async function releaseRepositoryRunBaselines(
  execution: ProcessExecutionPort | undefined,
  session: RuntimeSession
): Promise<void> {
  const bindings = repositoryBaselineBindings(session);
  if (bindings.length === 0) return;
  const release = execution?.releaseRepositoryRunBaseline;
  if (!release) {
    restorationFailure(
      "The execution broker cannot release run-scoped repository baselines.",
      "repository_atomicity_unavailable"
    );
  }
  const restoredRuns = new Set(session.durable.state.evidence.flatMap((evidence) =>
    evidence.kind === "restoration" && evidence.status === "passed"
      && evidence.data.repository.status === "restored" ? [evidence.runId] : []));
  for (const binding of bindings) {
    try {
      const result = await release.call(execution, {
        protocolVersion: 1,
        sessionId: session.identity.sessionId,
        runId: binding.runId,
        repositoryRoot: binding.repositoryRoot
      }, { timeoutMs: 120_000 });
      if (result.status !== "released") {
        restorationFailure(
          "The broker did not confirm repository baseline cleanup.",
          "repository_state_uncertain"
        );
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code) : undefined;
      if (code === "repository_atomicity_unavailable" && restoredRuns.has(binding.runId)) continue;
      throw error;
    }
  }
}

function repositoryBaselineBindings(
  session: RuntimeSession
): Array<{ runId: string; repositoryRoot: string }> {
  const workspace = path.resolve(session.identity.workspacePath);
  const values = [...session.durable.state.evidence, ...session.durable.state.mutationEvidence]
    .flatMap((evidence) => {
      if (evidence.kind !== "repository_delta" || evidence.status !== "passed"
        || !evidence.data.repositoryRoot) return [];
      const repositoryRoot = resolveRepositoryRoot(workspace, evidence.data.repositoryRoot);
      return [{ runId: evidence.runId, repositoryRoot }];
    });
  return [...new Map(values.map((value) => [
    `${value.runId}\u0000${value.repositoryRoot}`, value
  ])).values()];
}

function resolveRepositoryRoot(workspace: string, repositoryRoot: string): string {
  const absolute = path.resolve(workspace, repositoryRoot);
  const relative = path.relative(workspace, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    restorationFailure(
      "Repository restoration evidence escapes the active workspace.",
      "repository_state_uncertain"
    );
  }
  return absolute;
}
