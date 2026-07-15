import {
  isBudgetLedgerState,
  isCheckpointRef,
  isCompletionEligibleEvidence,
  isCompletionReferenceableEvidence,
  isEvidenceRecord,
  isPlanGraph,
  isUsageRecord,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "agent-protocol";
import type { KernelState } from "./state.js";
import { nextPhase } from "./terminal-reducer-helpers.js";
import { recordSemanticEvidenceProgress, recordSemanticWorkspaceRestore } from "./semantic-failures.js";

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

function isEvidenceAcquisitionRepair(state: KernelState): boolean {
  if (state.completionRepair?.kind === "evidence_acquisition") return true;
  return state.completionRepair === undefined
    && state.completionRepairAttempts > 0
    && !state.evidence.some((item) =>
      isCompletionReferenceableEvidence(item, state.sessionId, state.runId));
}

const evidenceRecorded: KernelEventReducer = (state, event) => {
  const evidence = event.payload;
  if (!isEvidenceRecord(evidence) || evidence.sessionId !== state.sessionId || evidence.runId !== state.runId
    || event.runId !== state.runId || !evidenceAuthorityAllowed(event, evidence)
    || state.evidence.some((item) => item.evidenceId === evidence.evidenceId)) return state;
  if (evidence.kind === "user_waiver" && state.evidence.some((item) => item.kind === "user_waiver")) return state;
  const firstCompletionEvidence = isEvidenceAcquisitionRepair(state)
    && isCompletionReferenceableEvidence(evidence, state.sessionId, state.runId)
    && !state.evidence.some((item) => isCompletionReferenceableEvidence(item, state.sessionId, state.runId));
  const progressed = recordSemanticEvidenceProgress({
    ...state,
    evidence: [...state.evidence, evidence],
    mutationEvidence: MUTATION_EVIDENCE_KINDS.has(evidence.kind)
      && !state.mutationEvidence.some((item) => item.evidenceId === evidence.evidenceId)
      ? [...state.mutationEvidence, evidence]
      : state.mutationEvidence
  }, evidence);
  return firstCompletionEvidence
    ? isCompletionEligibleEvidence(evidence, state.sessionId, state.runId)
      ? { ...progressed, completionRepairAttempts: 0, completionRepair: undefined }
      : { ...progressed, completionRepairAttempts: Math.max(1, state.completionRepairAttempts), completionRepair: { kind: "terminal_action" } }
    : progressed;
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

function checkpointRepairUpdate(
  state: KernelState,
  evidence: readonly EvidenceRecord[]
): Partial<Pick<KernelState, "completionRepairAttempts" | "completionRepair" | "messages">> {
  const repair = state.completionRepair;
  const protectedOrTerminal = repair?.kind === "protected_completion"
    || repair?.kind === "protected_recovery"
    || repair?.kind === "terminal_action";
  if (!protectedOrTerminal || evidence.some((item) =>
    isCompletionReferenceableEvidence(item, state.sessionId, state.runId))) return {};
  return {
    completionRepairAttempts: Math.max(1, state.completionRepairAttempts),
    completionRepair: { kind: "evidence_acquisition" },
    messages: [...state.messages, {
      role: "developer",
      content: "Checkpoint restoration removed the durable evidence for the pending terminal result. Obtain fresh current-run evidence before finalizing; request user input only if a concrete decision is genuinely required."
    }]
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
  const pruned = pruneRestoredCheckpointEvidence(state, event.payload.checkpointId);
  return recordSemanticWorkspaceRestore({
    ...state,
    ...pruned,
    ...checkpointRepairUpdate(state, pruned.evidence),
    checkpointHead
  });
};

const checkpointRecoveryResolved: KernelEventReducer = (state, event) => {
  if (event.authority !== "user" || state.phase !== "needs_input") return state;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
  // Child decisions are recorded before applying a foreign checkpoint so a
  // crash can replay them. They only unblock the parent after the apply step
  // has durably completed.
  if (payload.sourceSessionId !== undefined && payload.applied !== true) return state;
  return { ...state, phase: nextPhase(state.pendingTools), outcome: undefined, proposedOutcome: undefined };
};

const reviewEvidence: KernelEventReducer = (state, event, payload) => evidenceRecorded(state, event, payload);

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
    || !validSkillLoadedPayload(payload)) return state;
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
  "checkpoint.recovery_resolved": checkpointRecoveryResolved,
  "review.completed": reviewEvidence,
  "review.waived": reviewEvidence,
  "profile.resolved": profileResolved,
  "customization.frozen": customizationFrozen,
  "skill.loaded": skillLoaded,
  "process.spawned": processSpawned,
  "process.exited": processSettled,
  "process.lost": processSettled
};
