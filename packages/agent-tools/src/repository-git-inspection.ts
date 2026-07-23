import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  RepositoryRecoverySelectionEvidenceV1,
  ToolExecutionContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import type { ProcessExecutionPort } from "agent-platform";
import type { RegisteredEffectTool } from "./registry.js";
import {
  repositoryInspectionTopologyCandidate,
  type RepositoryWorktreeTopology
} from "./repository-git-execution.js";
import {
  collectRepositoryInspectionV2,
  repositoryInspectionDigest
} from "./repository-git-inspection-probes.js";
import type {
  RepositoryInspectionV2,
  RepositoryRecoveryCandidateV2
} from "./repository-git-inspection-types.js";
import { RepositoryRecoverySelectionStore } from "./repository-recovery-selection.js";
import {
  repositoryToolResult,
  repositoryToolSchema,
  structuredReadEvidence
} from "./repository-tool-support.js";

export * from "./repository-git-inspection-probes.js";
export * from "./repository-git-inspection-types.js";

function inspectionRepositoryStateDigest(
  topology: RepositoryWorktreeTopology,
  inspection: RepositoryInspectionV2
): string {
  return repositoryInspectionDigest({
    root: topology.worktreeRoot,
    head: inspection.head,
    symbolicRef: inspection.symbolicRef,
    status: inspection.status.digest,
    refs: inspection.refs.digest,
    reflog: inspection.reflog.digest,
    unreachable: inspection.unreachable.digest
  });
}

function selectionEvidence(
  request: ToolRequest,
  context: ToolExecutionContext,
  topology: RepositoryWorktreeTopology,
  inspection: RepositoryInspectionV2,
  candidate: RepositoryRecoveryCandidateV2,
  selectionKind: "unique" | "model_selectable"
): RepositoryRecoverySelectionEvidenceV1 | undefined {
  const goalEpoch = context.goalEpoch;
  if (goalEpoch === undefined) return undefined;
  return {
    evidenceId: `repository-recovery-selection:${randomUUID()}`,
    sessionId: context.sessionId,
    runId: context.runId,
    kind: "repository_recovery_selection",
    status: "passed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: request.callId },
    summary: selectionKind === "unique"
      ? "The runtime proved one current repository recovery candidate."
      : "The runtime issued a freshness-bound capability for one model-selectable recovery candidate.",
    data: {
      schemaVersion: 1,
      goalEpoch,
      repositoryRoot: ".",
      candidateId: candidate.candidateId,
      selectedObject: candidate.object,
      selectionKind,
      inspectionBasisDigest: inspection.basisDigest,
      inspectedHead: inspection.head,
      inspectedSymbolicRef: inspection.symbolicRef,
      statusDigest: inspection.status.digest,
      refsDigest: inspection.refs.digest,
      reflogDigest: inspection.reflog.digest,
      repositoryStateDigest: inspectionRepositoryStateDigest(topology, inspection)
    }
  };
}

function applySelection(
  request: ToolRequest,
  context: ToolExecutionContext,
  topology: RepositoryWorktreeTopology,
  inspection: RepositoryInspectionV2,
  store?: RepositoryRecoverySelectionStore
): RepositoryRecoverySelectionEvidenceV1[] {
  if (!inspection.complete) {
    inspection.selectionStatus = { status: "unavailable", reason: "inspection_incomplete" };
    return [];
  }
  if (inspection.recoveryCandidates.length === 0) {
    inspection.selectionStatus = { status: "none" };
    return [];
  }
  if (!store) {
    inspection.selectionStatus = { status: "unavailable", reason: "selection_store_unavailable" };
    return [];
  }
  const selectionKind = inspection.recoveryCandidates.length === 1
    ? "unique" as const
    : "model_selectable" as const;
  const selections = inspection.recoveryCandidates.flatMap((candidate) => {
    const evidence = selectionEvidence(
      request, context, topology, inspection, candidate, selectionKind
    );
    if (!evidence) return [];
    store.record({ evidence, repositoryRoot: topology.worktreeRoot, selectedObject: candidate.object });
    candidate.selectionEvidenceId = evidence.evidenceId;
    return [evidence];
  });
  if (selections.length !== inspection.recoveryCandidates.length) {
    inspection.selectionStatus = { status: "unavailable", reason: "goal_epoch_unavailable" };
    return [];
  }
  const only = inspection.recoveryCandidates.length === 1
    ? inspection.recoveryCandidates[0]
    : undefined;
  inspection.selectionStatus = only ? {
    status: "selected",
    candidateId: only.candidateId,
    selectionEvidenceId: only.selectionEvidenceId!,
    selectionKind: "unique"
  } : {
    status: "model_choice_available",
    candidateIds: inspection.recoveryCandidates.map((item) => item.candidateId)
  };
  return selections;
}

function repositoryInspectionReceipt(
  request: ToolRequest,
  context: ToolExecutionContext,
  startedAt: string,
  value: RepositoryInspectionV2,
  selections: readonly RepositoryRecoverySelectionEvidenceV1[]
): ToolReceipt {
  const output = JSON.stringify(value);
  const readEvidence = structuredReadEvidence(
    request, context, ".", output, "Inspected structured Git repository state."
  );
  return {
    ...repositoryToolResult(
      request,
      startedAt,
      output,
      true,
      value.complete ? ["repository_inspection_complete"] : ["repository_inspection_partial"],
      [],
      [readEvidence],
      value as unknown as JsonValue
    ),
    observedEffects: ["filesystem.read", "process.spawn.readonly"],
    actualEffects: ["filesystem.read", "process.spawn.readonly"],
    evidence: [readEvidence, ...selections]
  };
}

async function executeRepositoryInspection(
  execution: ProcessExecutionPort | undefined,
  request: ToolRequest,
  context: ToolExecutionContext,
  store?: RepositoryRecoverySelectionStore
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  if (!execution) {
    return repositoryToolResult(
      request, startedAt, "Git execution is unavailable.", false, ["repository_probe_failed"]
    );
  }
  try {
    const topology = await repositoryInspectionTopologyCandidate(context);
    const value = await collectRepositoryInspectionV2(execution, topology, context.signal);
    const selections = applySelection(request, context, topology, value, store);
    return repositoryInspectionReceipt(request, context, startedAt, value, selections);
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "repository_probe_failed";
    return repositoryToolResult(
      request, startedAt, error instanceof Error ? error.message : String(error), false, [code]
    );
  }
}

export function repositoryInspectTool(
  execution?: ProcessExecutionPort,
  store?: RepositoryRecoverySelectionStore
): RegisteredEffectTool {
  return {
    descriptor: repositoryToolSchema({
      name: "repository_inspect",
      description: "Inspect bounded Git HEAD, status, refs, newest-first reflog identities, and unreachable objects. Each current recovery candidate receives a freshness-bound selectionEvidenceId; choose a candidate yourself and pass both IDs to git_transaction.",
      properties: {},
      possibleEffects: ["filesystem.read", "process.spawn.readonly"],
      executionMode: "parallel",
      resourceKeys: ["workspace:git-read"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 45_000,
      prepare() {
        return {
          exactEffects: ["filesystem.read", "process.spawn.readonly"],
          readPaths: ["."], writePaths: [], network: "none", processMode: "pipe",
          checkpointScope: [], idempotence: "read_only"
        };
      }
    }),
    async execute(request, context) {
      return await executeRepositoryInspection(execution, request, context, store);
    }
  };
}
