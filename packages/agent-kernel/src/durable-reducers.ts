import {
  isBudgetLedgerState,
  isCheckpointRef,
  isEvidenceRecord,
  isPlanGraph,
  isUsageRecord,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "agent-protocol";
import type { KernelState } from "./state.js";

export type KernelEventReducer = (
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Record<string, JsonValue>
) => KernelState;

const TOOL_EVIDENCE_KINDS = new Set(["workspace_delta", "command", "validation", "diagnostic"]);
const MUTATION_EVIDENCE_KINDS = new Set(["workspace_delta", "validation", "review", "user_waiver"]);

function evidenceAuthorityAllowed(event: AgentEventEnvelope, evidence: EvidenceRecord): boolean {
  if (event.type === "review.completed") {
    return event.authority === "runtime" && evidence.kind === "review" && evidence.producer.authority === "runtime";
  }
  if (event.type === "review.waived") {
    return event.authority === "user" && evidence.kind === "user_waiver" && evidence.producer.authority === "user";
  }
  if (event.type !== "evidence.recorded") return false;
  if (event.authority === "tool") return evidence.producer.authority === "tool" && TOOL_EVIDENCE_KINDS.has(evidence.kind);
  return event.authority === "runtime" && evidence.producer.authority === "runtime"
    && evidence.kind !== "review" && evidence.kind !== "user_waiver";
}

const evidenceRecorded: KernelEventReducer = (state, event) => {
  const evidence = event.payload;
  if (!isEvidenceRecord(evidence) || evidence.sessionId !== state.sessionId || evidence.runId !== state.runId
    || event.runId !== state.runId || !evidenceAuthorityAllowed(event, evidence)
    || state.evidence.some((item) => item.evidenceId === evidence.evidenceId)) return state;
  if (evidence.kind === "user_waiver" && state.evidence.some((item) => item.kind === "user_waiver")) return state;
  return {
    ...state,
    evidence: [...state.evidence, evidence],
    mutationEvidence: MUTATION_EVIDENCE_KINDS.has(evidence.kind)
      && !state.mutationEvidence.some((item) => item.evidenceId === evidence.evidenceId)
      ? [...state.mutationEvidence, evidence]
      : state.mutationEvidence
  };
};

const usageRecorded: KernelEventReducer = (state, event) => {
  const usage = event.payload;
  if (!isUsageRecord(usage) || usage.sessionId !== state.sessionId
    || state.usage.some((item) => item.usageId === usage.usageId)) return state;
  return { ...state, usage: [...state.usage, usage] };
};

const planUpdated: KernelEventReducer = (state, _event, payload) => {
  if (!isPlanGraph(payload.plan) || !Number.isSafeInteger(payload.previousRevision)
    || payload.previousRevision !== state.plan.revision || payload.plan.revision !== state.plan.revision + 1) return state;
  return { ...state, plan: payload.plan };
};

const budgetUpdated: KernelEventReducer = (state, _event, payload) => isBudgetLedgerState(payload.ledger)
  ? { ...state, budget: payload.ledger }
  : state;

const budgetLimitIncreased: KernelEventReducer = (state, event, payload) =>
  event.authority === "user" && isBudgetLedgerState(payload.ledger)
    ? { ...state, budget: payload.ledger }
    : state;

function pruneRestoredCheckpointEvidence(
  state: KernelState,
  checkpointId: string
): Pick<KernelState, "evidence" | "mutationEvidence"> {
  const records = [...state.mutationEvidence, ...state.evidence];
  const restoredDeltaIds = new Set(records.flatMap((item) => item.kind === "workspace_delta"
    && item.data.checkpointId === checkpointId ? [item.evidenceId] : []));
  const prune = (items: readonly EvidenceRecord[]): EvidenceRecord[] => items.flatMap((item) => {
    if (item.kind === "workspace_delta" && restoredDeltaIds.has(item.evidenceId)) return [];
    if (item.kind === "validation"
      && item.data.workspaceDeltaEvidenceIds.some((id) => restoredDeltaIds.has(id))) {
      const workspaceDeltaEvidenceIds = item.data.workspaceDeltaEvidenceIds
        .filter((id) => !restoredDeltaIds.has(id));
      return workspaceDeltaEvidenceIds.length === 0 ? [] : [{
        ...item,
        data: { ...item.data, workspaceDeltaEvidenceIds }
      }];
    }
    if (item.kind === "review"
      && item.data.workspaceDeltaEvidenceIds.some((id) => restoredDeltaIds.has(id))) {
      const workspaceDeltaEvidenceIds = item.data.workspaceDeltaEvidenceIds
        .filter((id) => !restoredDeltaIds.has(id));
      return workspaceDeltaEvidenceIds.length === 0 ? [] : [{
        ...item,
        data: { ...item.data, workspaceDeltaEvidenceIds }
      }];
    }
    if (item.kind === "user_waiver" && item.data.checkpointId === checkpointId) return [];
    return [item];
  });
  return {
    evidence: prune(state.evidence),
    mutationEvidence: prune(state.mutationEvidence)
  };
}

const checkpointUpdated: KernelEventReducer = (state, event) => {
  if (!isCheckpointRef(event.payload) || event.payload.sessionId !== state.sessionId
    || event.sessionId !== state.sessionId || event.runId !== state.runId) return state;
  const requiredStatus = event.type === "checkpoint.created" ? "open"
    : event.type === "checkpoint.sealed" ? "sealed" : "restored";
  if (event.payload.status !== requiredStatus) return state;
  if (requiredStatus !== "restored") {
    return event.authority === "runtime" && event.payload.runId === state.runId
      ? { ...state, checkpointHead: event.payload } : state;
  }
  if (event.authority !== "runtime" && event.authority !== "user") return state;
  const checkpointHead = event.payload.runId === state.runId
    ? event.payload : { ...event.payload, runId: state.runId };
  return {
    ...state,
    ...pruneRestoredCheckpointEvidence(state, event.payload.checkpointId),
    checkpointHead
  };
};

const reviewEvidence: KernelEventReducer = (state, event, payload) => evidenceRecorded(state, event, payload);

const profileResolved: KernelEventReducer = (state, _event, payload) => {
  if (typeof payload.profileId !== "string" || typeof payload.digest !== "string"
    || typeof payload.artifactId !== "string"
    || (payload.source !== "home" && payload.source !== "workspace" && payload.source !== "builtin")) return state;
  return { ...state, frozenProfile: {
    artifactId: payload.artifactId,
    digest: payload.digest,
    source: payload.source,
    qualifiedName: payload.profileId
  } };
};

const customizationFrozen: KernelEventReducer = (state, _event, payload) => {
  if (typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/u.test(payload.digest)
    || typeof payload.artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(payload.artifactId)) return state;
  return { ...state, frozenCustomization: { artifactId: payload.artifactId, digest: payload.digest } };
};

const skillLoaded: KernelEventReducer = (state, _event, payload) => {
  if (typeof payload.qualifiedName !== "string" || typeof payload.digest !== "string"
    || typeof payload.artifactId !== "string"
    || (payload.source !== "home" && payload.source !== "workspace" && payload.source !== "builtin")) return state;
  if (state.frozenSkills.some((item) => item.qualifiedName === payload.qualifiedName)) return state;
  return { ...state, frozenSkills: [...state.frozenSkills, {
    artifactId: payload.artifactId,
    digest: payload.digest,
    source: payload.source,
    qualifiedName: payload.qualifiedName,
    ...(typeof payload.executionManifestArtifactId === "string" && /^[a-f0-9]{64}$/u.test(payload.executionManifestArtifactId)
      && typeof payload.executionManifestDigest === "string" && /^[a-f0-9]{64}$/u.test(payload.executionManifestDigest) ? {
        executionManifestArtifactId: payload.executionManifestArtifactId,
        executionManifestDigest: payload.executionManifestDigest
      } : {})
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
  return { ...state, activeProcessIds: state.activeProcessIds.filter((id) => id !== payload.processId) };
};

export const durableReducers: Partial<Record<AgentEventType, KernelEventReducer>> = {
  "evidence.recorded": evidenceRecorded,
  "usage.recorded": usageRecorded,
  "plan.updated": planUpdated,
  "budget.reserved": budgetUpdated,
  "budget.reservation_bound": budgetUpdated,
  "budget.committed": budgetUpdated,
  "budget.released": budgetUpdated,
  "budget.limit_increased": budgetLimitIncreased,
  "checkpoint.created": checkpointUpdated,
  "checkpoint.sealed": checkpointUpdated,
  "checkpoint.restored": checkpointUpdated,
  "review.completed": reviewEvidence,
  "review.waived": reviewEvidence,
  "profile.resolved": profileResolved,
  "customization.frozen": customizationFrozen,
  "skill.loaded": skillLoaded,
  "process.spawned": processSpawned,
  "process.exited": processSettled,
  "process.lost": processSettled
};
