import {
  isCheckpointRef,
  isEvidenceRecord,
  isPlanGraph,
  isLongHorizonState,
  isReasoningTrajectoryState,
  isToolResultPruneState,
  isUsageRecord,
  type AgentEventEnvelope,
  type AgentEventType,
  type ContextItem,
  type EvidenceRecord,
  type JsonValue,
  type ReviewerToolReceipt
} from "agent-protocol";
import { durableBudgetReducers } from "./durable-budget-reducers.js";
import {
  frontierAfterCheckpoint,
  frontierAfterEvidence,
  isEnclosingContainerMutationEvidence
} from "./mutation-frontier.js";
import type { KernelEventReducer } from "./durable-reducer-types.js";
import type { KernelState, PendingTool } from "./state.js";

export type { KernelEventReducer } from "./durable-reducer-types.js";

const TOOL_EVIDENCE_KINDS = new Set([
  "workspace_delta", "repository_delta", "command", "validation", "diagnostic", "input_access"
]);
const MUTATION_EVIDENCE_KINDS = new Set([
  "workspace_delta", "repository_delta", "repository_acceptance",
  "validation", "review", "user_waiver"
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nextPhase(pending: readonly PendingTool[]): KernelState["phase"] {
  if (pending.some((item) => item.approval === "pending")) return "needs_input";
  if (pending.some((item) => item.started)) return "tool_in_flight";
  return pending.length > 0 ? "tool_pending" : "ready_model";
}

function evidenceAuthorityAllowed(event: AgentEventEnvelope, evidence: EvidenceRecord): boolean {
  if (event.type === "review.completed") {
    return event.authority === "runtime" && evidence.kind === "review"
      && evidence.producer.authority === "runtime";
  }
  if (event.type === "review.waived") {
    return event.authority === "user" && evidence.kind === "user_waiver"
      && evidence.producer.authority === "user";
  }
  if (event.type !== "evidence.recorded") return false;
  if (event.authority === "tool") {
    return evidence.producer.authority === "tool" && TOOL_EVIDENCE_KINDS.has(evidence.kind);
  }
  return event.authority === "runtime" && evidence.producer.authority === "runtime"
    && evidence.kind !== "review" && evidence.kind !== "user_waiver";
}

function canRecordEvidence(
  state: KernelState,
  event: AgentEventEnvelope,
  evidence: EvidenceRecord
): boolean {
  return evidence.sessionId === state.sessionId
    && evidence.runId === state.runId
    && event.runId === state.runId
    && evidenceAuthorityAllowed(event, evidence)
    && !state.evidence.some((item) => item.evidenceId === evidence.evidenceId)
    && !(evidence.kind === "user_waiver"
      && state.evidence.some((item) => item.kind === "user_waiver"));
}

function restoredFrontier(
  state: KernelState,
  evidence: Extract<EvidenceRecord, { kind: "restoration" }>
): KernelState {
  if (evidence.status !== "passed") return state;
  const data = evidence.data;
  const frontier = state.mutationFrontier;
  const repositoryRestored = frontier.repositoryStateDigest === undefined
    ? data.repository.status === "unchanged"
    : data.repository.status === "restored" && data.repository.stateDigest !== undefined;
  if (data.frontierRevision !== frontier.revision
    || data.frontierStateDigest !== frontier.currentStateDigest
    || data.baselineManifestDigest !== data.currentManifestDigest
    || !repositoryRestored
    || (frontier.environmentChangedPaths?.length ?? 0) > 0) return state;
  return {
    ...state,
    mutationEvidence: state.mutationEvidence.filter((item) =>
      item.runId !== evidence.runId
      || (item.kind !== "repository_delta" && item.kind !== "repository_acceptance")),
    mutationFrontier: {
      revision: frontier.revision + 1,
      baselineManifestDigest: data.currentManifestDigest,
      currentStateDigest: data.currentManifestDigest,
      changedPaths: [],
      environmentChangedPaths: [],
      sourceCheckpointIds: []
    }
  };
}

const evidenceRecorded: KernelEventReducer = (state, event) => {
  const evidence = event.payload;
  if (!isEvidenceRecord(evidence) || !canRecordEvidence(state, event, evidence)) return state;
  const mutationEvidence = MUTATION_EVIDENCE_KINDS.has(evidence.kind)
    || isEnclosingContainerMutationEvidence(evidence)
    ? [...state.mutationEvidence, evidence]
    : state.mutationEvidence;
  const next = {
    ...state,
    evidence: [...state.evidence, evidence],
    mutationEvidence,
    mutationFrontier: frontierAfterEvidence(state.mutationFrontier, mutationEvidence, evidence)
  };
  return evidence.kind === "restoration" ? restoredFrontier(next, evidence) : next;
};

const usageRecorded: KernelEventReducer = (state, event) => {
  const usage = event.payload;
  if (!isUsageRecord(usage) || usage.sessionId !== state.sessionId
    || state.usage.some((item) => item.usageId === usage.usageId)) return state;
  return { ...state, usage: [...state.usage, usage] };
};

const planUpdated: KernelEventReducer = (state, _event, payload) => {
  if (!isPlanGraph(payload.plan) || !Number.isSafeInteger(payload.previousRevision)
    || payload.previousRevision !== state.plan.revision
    || payload.plan.revision !== state.plan.revision + 1) return state;
  return { ...state, plan: payload.plan };
};

const longHorizonUpdated: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || !isLongHorizonState(payload.state)) return state;
  return { ...state, longHorizon: payload.state };
};

const reviewToolCompleted: KernelEventReducer = (state, event, payload) => {
  const item = payload as unknown as ReviewerToolReceipt;
  if (event.authority !== "runtime"
    || item.schemaVersion !== 1
    || typeof item.reviewRequestId !== "string"
    || typeof item.call?.id !== "string"
    || typeof item.receipt?.callId !== "string"
    || item.call.id !== item.receipt.callId
    || state.reviewReceipts.some((prior) =>
      prior.reviewRequestId === item.reviewRequestId
      && prior.call.id === item.call.id)) return state;
  return {
    ...state,
    reviewReceipts: [...state.reviewReceipts, item]
  };
};

const reasoningTrajectoryTombstoned: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime"
    || !isReasoningTrajectoryState(payload.state)) return state;
  return { ...state, reasoningTrajectory: payload.state };
};

function pruneRestoredCheckpointEvidence(
  state: KernelState,
  checkpointId: string
): Pick<KernelState, "evidence" | "mutationEvidence"> {
  const records = [...state.mutationEvidence, ...state.evidence];
  const restoredDeltaIds = new Set(records.flatMap((item) => item.kind === "workspace_delta"
    && item.data.checkpointId === checkpointId ? [item.evidenceId] : []));
  const prune = (items: readonly EvidenceRecord[]): EvidenceRecord[] => items.filter((item) =>
    !(item.kind === "workspace_delta" && restoredDeltaIds.has(item.evidenceId))
    && !(item.kind === "user_waiver" && item.data.checkpointId === checkpointId));
  return { evidence: prune(state.evidence), mutationEvidence: prune(state.mutationEvidence) };
}

const checkpointUpdated: KernelEventReducer = (state, event) => {
  if (!isCheckpointRef(event.payload) || event.payload.sessionId !== state.sessionId
    || event.sessionId !== state.sessionId || event.runId !== state.runId) return state;
  const requiredStatus = event.type === "checkpoint.created" ? "open"
    : event.type === "checkpoint.sealed" ? "sealed" : "restored";
  if (event.payload.status !== requiredStatus) return state;
  if (requiredStatus !== "restored") {
    if (event.authority !== "runtime" || event.payload.runId !== state.runId) return state;
    return {
      ...state,
      checkpointHead: event.payload,
      ...(requiredStatus === "sealed"
        ? { mutationFrontier: frontierAfterCheckpoint(
            state.mutationFrontier,
            event.payload,
            state.mutationEvidence
          ) }
        : {})
    };
  }
  if (event.authority !== "runtime" && event.authority !== "user") return state;
  const checkpointHead = event.payload.runId === state.runId
    ? event.payload
    : { ...event.payload, runId: state.runId };
  const pruned = pruneRestoredCheckpointEvidence(state, event.payload.checkpointId);
  return {
    ...state,
    ...pruned,
    checkpointHead,
    mutationFrontier: frontierAfterCheckpoint(
      state.mutationFrontier,
      checkpointHead,
      pruned.mutationEvidence
    )
  };
};

const checkpointRecoveryResolved: KernelEventReducer = (state, event) => {
  if (event.authority !== "user" || state.phase !== "needs_input") return state;
  const payload = record(event.payload);
  if (payload?.sourceSessionId !== undefined && payload.applied !== true) return state;
  return {
    ...state,
    phase: nextPhase(state.pendingTools),
    outcome: undefined,
    proposedOutcome: undefined
  };
};

const profileResolved: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || event.sessionId !== state.sessionId
    || typeof payload.profileId !== "string" || typeof payload.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(payload.digest)
    || typeof payload.artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(payload.artifactId)
    || (payload.source !== "home" && payload.source !== "workspace" && payload.source !== "builtin")) return state;
  return { ...state, frozenProfile: {
    artifactId: payload.artifactId,
    digest: payload.digest,
    source: payload.source,
    qualifiedName: payload.profileId
  } };
};

const customizationFrozen: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || event.sessionId !== state.sessionId
    || typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/u.test(payload.digest)
    || typeof payload.artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(payload.artifactId)) return state;
  return { ...state, frozenCustomization: { artifactId: payload.artifactId, digest: payload.digest } };
};

const harnessCompiled: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || event.sessionId !== state.sessionId
    || payload.schemaVersion !== 1
    || typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/u.test(payload.digest)
    || typeof payload.artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(payload.artifactId)
    || payload.artifactId !== payload.digest) {
    return state;
  }
  return {
    ...state,
    harnessRequired: true,
    frozenHarness: { artifactId: payload.artifactId, digest: payload.digest }
  };
};

const toolBundleLoaded: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || event.sessionId !== state.sessionId
    || typeof payload.bundleId !== "string"
    || typeof payload.harnessDigest !== "string"
    || payload.harnessDigest !== state.frozenHarness?.digest
    || state.loadedToolBundles?.includes(payload.bundleId)) return state;
  return {
    ...state,
    loadedToolBundles: [...(state.loadedToolBundles ?? []), payload.bundleId].sort()
  };
};

function validSkillLoadedPayload(payload: Record<string, JsonValue>): payload is Record<string, JsonValue> & {
  qualifiedName: string;
  digest: string;
  artifactId: string;
  source: "home" | "workspace" | "builtin";
} {
  return typeof payload.qualifiedName === "string" && payload.qualifiedName.length > 0
    && typeof payload.digest === "string" && /^[a-f0-9]{64}$/u.test(payload.digest)
    && typeof payload.artifactId === "string" && /^[a-f0-9]{64}$/u.test(payload.artifactId)
    && (payload.source === "home" || payload.source === "workspace" || payload.source === "builtin");
}

const skillLoaded: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || event.sessionId !== state.sessionId
    || !validSkillLoadedPayload(payload)
    || state.frozenSkills.some((item) => item.qualifiedName === payload.qualifiedName)) return state;
  return { ...state, frozenSkills: [...state.frozenSkills, {
    artifactId: payload.artifactId,
    digest: payload.digest,
    source: payload.source,
    qualifiedName: payload.qualifiedName,
    ...(typeof payload.executionManifestArtifactId === "string"
      && /^[a-f0-9]{64}$/u.test(payload.executionManifestArtifactId)
      && typeof payload.executionManifestDigest === "string"
      && /^[a-f0-9]{64}$/u.test(payload.executionManifestDigest)
      ? {
          executionManifestArtifactId: payload.executionManifestArtifactId,
          executionManifestDigest: payload.executionManifestDigest
        }
      : {})
  }] };
};

const processSpawned: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || event.runId !== state.runId
    || typeof payload.processId !== "string" || !payload.processId
    || state.activeProcessIds.includes(payload.processId)) return state;
  return { ...state, activeProcessIds: [...state.activeProcessIds, payload.processId] };
};

const processSettled: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || typeof payload.processId !== "string") return state;
  return {
    ...state,
    activeProcessIds: state.activeProcessIds.filter((id) => id !== payload.processId)
  };
};

const contextCompacted: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime") return state;
  const item = record(payload.item);
  const sourceDigest = typeof item?.cacheKey === "string" ? item.cacheKey : "";
  if (!/^[a-f0-9]{64}$/u.test(sourceDigest)
    || !Number.isSafeInteger(payload.omittedHistoryTurns)
    || Number(payload.omittedHistoryTurns) < 0) return state;
  return {
    ...state,
    contextArchive: {
      schemaVersion: 1,
      item: payload.item as unknown as ContextItem,
      omittedHistoryTurns: Number(payload.omittedHistoryTurns),
      sourceDigest
    }
  };
};

const toolResultsPruned: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || !isToolResultPruneState(payload.state)) return state;
  const current = state.toolResultPrune;
  if (current && current.archiveSourceDigest === payload.state.archiveSourceDigest
    && payload.state.coveredBlocks < current.coveredBlocks) return state;
  return { ...state, toolResultPrune: payload.state };
};

export const durableReducers: Partial<Record<AgentEventType, KernelEventReducer>> = {
  "evidence.recorded": evidenceRecorded,
  "usage.recorded": usageRecorded,
  "plan.updated": planUpdated,
  "long_horizon.updated": longHorizonUpdated,
  "review.tool_completed": reviewToolCompleted,
  "context.reasoning_trajectory_tombstoned": reasoningTrajectoryTombstoned,
  ...durableBudgetReducers,
  "checkpoint.created": checkpointUpdated,
  "checkpoint.sealed": checkpointUpdated,
  "checkpoint.restored": checkpointUpdated,
  "checkpoint.recovery_resolved": checkpointRecoveryResolved,
  "review.completed": evidenceRecorded,
  "review.waived": evidenceRecorded,
  "profile.resolved": profileResolved,
  "customization.frozen": customizationFrozen,
  "harness.compiled": harnessCompiled,
  "tool_bundle.loaded": toolBundleLoaded,
  "skill.loaded": skillLoaded,
  "process.spawned": processSpawned,
  "process.exited": processSettled,
  "process.lost": processSettled,
  "process.handed_off": processSettled,
  "context.compacted": contextCompacted,
  "context.tool_results_pruned": toolResultsPruned
};
