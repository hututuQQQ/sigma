import {
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
import { frontierAfterCheckpoint, frontierAfterEvidence } from "./mutation-frontier.js";
import { nextPhase } from "./terminal-reducer-helpers.js";
import { recordSemanticEvidenceProgress, recordSemanticWorkspaceRestore } from "./semantic-failures.js";
import { durableBudgetReducers } from "./durable-budget-reducers.js";
import { reviewTaskControl } from "./review-task-control-reducer.js";
import {
  advanceReviewRepair,
  completionEvidenceObligation,
  recordSemanticFact,
  resolveTaskObligation,
  terminalResolutionObligation
} from "./task-control.js";
import { advanceRepositoryEvidenceObligation } from "./repository-task-control.js";

export type KernelEventReducer = (
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Record<string, JsonValue>
) => KernelState;

const TOOL_EVIDENCE_KINDS = new Set([
  "workspace_delta", "repository_delta", "command", "validation", "diagnostic", "input_access"
]);
const MUTATION_EVIDENCE_KINDS = new Set([
  "workspace_delta", "repository_delta", "repository_acceptance",
  "validation", "review", "user_waiver"
]);

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
  return state.taskControl.obligation?.kind === "completion_evidence"
    && state.taskControl.obligation.stage === "acquire";
}

function canRecordEvidence(
  state: KernelState,
  event: AgentEventEnvelope,
  evidence: EvidenceRecord
): boolean {
  return evidence.sessionId === state.sessionId && evidence.runId === state.runId
    && event.runId === state.runId && evidenceAuthorityAllowed(event, evidence)
    && !state.evidence.some((item) => item.evidenceId === evidence.evidenceId)
    && !(evidence.kind === "user_waiver" && state.evidence.some((item) => item.kind === "user_waiver"));
}

function appendEvidence(state: KernelState, evidence: EvidenceRecord): KernelState {
  const mutationEvidence = MUTATION_EVIDENCE_KINDS.has(evidence.kind)
    && !state.mutationEvidence.some((item) => item.evidenceId === evidence.evidenceId)
    ? [...state.mutationEvidence, evidence]
    : state.mutationEvidence;
  return applyWorkspaceRestorationEvidence(recordSemanticEvidenceProgress({
    ...state,
    evidence: [...state.evidence, evidence],
    mutationEvidence,
    mutationFrontier: frontierAfterEvidence(state.mutationFrontier, mutationEvidence, evidence)
  }, evidence), evidence);
}

function settleFirstCompletionEvidence(
  state: KernelState,
  evidence: EvidenceRecord,
  firstCompletionEvidence: boolean
): KernelState {
  if (!firstCompletionEvidence) return state;
  if (isCompletionEligibleEvidence(evidence, state.sessionId, state.runId)) {
    return { ...state, taskControl: resolveTaskObligation(state.taskControl) };
  }
  return {
    ...state,
    taskControl: completionEvidenceObligation(
      state.taskControl,
      state.revision,
      "terminal",
      currentReferenceableEvidenceCount(state)
    )
  };
}

const evidenceRecorded: KernelEventReducer = (state, event) => {
  const evidence = event.payload;
  if (!isEvidenceRecord(evidence) || !canRecordEvidence(state, event, evidence)) return state;
  const firstCompletionEvidence = isEvidenceAcquisitionRepair(state)
    && isCompletionReferenceableEvidence(evidence, state.sessionId, state.runId)
    && !state.evidence.some((item) => isCompletionReferenceableEvidence(item, state.sessionId, state.runId));
  const repaired = settleFirstCompletionEvidence(appendEvidence(state, evidence), evidence, firstCompletionEvidence);
  return advanceEvidenceObligation(
    evidence.kind === "review" ? reviewTaskControl(repaired, evidence) : repaired,
    evidence
  );
};

function applyWorkspaceRestorationEvidence(state: KernelState, evidence: EvidenceRecord): KernelState {
  if (evidence.kind !== "restoration" || evidence.status !== "passed") return state;
  const data = evidence.data;
  const frontier = state.mutationFrontier;
  const explicitRestore = data.restoredCheckpointIds.length > 0;
  const repositoryRestored = frontier.repositoryStateDigest === undefined
    ? data.repository.status === "unchanged"
    : data.repository.status === "restored" && data.repository.stateDigest !== undefined;
  if (data.goalEpoch !== state.taskControl.goalEpoch
    || data.frontierRevision !== frontier.revision
    || data.frontierStateDigest !== frontier.currentStateDigest
    || data.baselineManifestDigest !== data.currentManifestDigest
    || (!explicitRestore && state.taskControl.goalEpochSource !== "steer")
    || !repositoryRestored) return state;
  return {
    ...state,
    taskControl: resolveTaskObligation(state.taskControl),
    mutationEvidence: state.mutationEvidence.filter((item) =>
      item.runId !== evidence.runId
      || (item.kind !== "repository_delta" && item.kind !== "repository_acceptance")),
    mutationFrontier: {
      revision: frontier.revision + 1,
      baselineManifestDigest: data.currentManifestDigest,
      currentStateDigest: data.currentManifestDigest,
      changedPaths: [],
      sourceCheckpointIds: []
    }
  };
}

function advanceEvidenceObligation(state: KernelState, evidence: EvidenceRecord): KernelState {
  const repository = advanceRepositoryEvidenceObligation(state, evidence);
  if (repository) return repository;
  const obligation = state.taskControl.obligation;
  if (obligation?.kind !== "review_repair") return state;
  if (obligation.stage === "mutate" && evidence.kind === "workspace_delta"
    && isCompletionEligibleEvidence(evidence, state.sessionId, state.runId)) {
    return { ...state, taskControl: advanceReviewRepair(state.taskControl, "validate", state.revision) };
  }
  if (obligation.stage === "validate" && evidence.kind === "validation") {
    return {
      ...state,
      taskControl: evidence.status === "passed"
        ? advanceReviewRepair(state.taskControl, "re_review", state.revision)
        : terminalResolutionObligation(state.taskControl, state.revision, "validation_failed")
    };
  }
  return state;
}

function currentReferenceableEvidenceCount(state: KernelState): number {
  return state.evidence.filter((item) =>
    isCompletionReferenceableEvidence(item, state.sessionId, state.runId)).length;
}

const usageRecorded: KernelEventReducer = (state, event) => {
  const usage = event.payload;
  if (!isUsageRecord(usage) || usage.sessionId !== state.sessionId
    || state.usage.some((item) => item.usageId === usage.usageId)) return state;
  return { ...state, usage: [...state.usage, usage] };
};

const planUpdated: KernelEventReducer = (state, _event, payload) => {
  if (!isPlanGraph(payload.plan) || !Number.isSafeInteger(payload.previousRevision)
    || payload.previousRevision !== state.plan.revision || payload.plan.revision !== state.plan.revision + 1) return state;
  const fact = recordSemanticFact(state.taskControl, "plan", {
    revision: payload.plan.revision,
    activeNodeId: payload.plan.activeNodeId,
    nodes: payload.plan.nodes.map((node) => ({ id: node.id, status: node.status }))
  }, state.revision);
  return { ...state, plan: payload.plan, taskControl: fact.control };
};

function pruneRestoredCheckpointEvidence(
  state: KernelState,
  checkpointId: string
): Pick<KernelState, "evidence" | "mutationEvidence"> {
  const records = [...state.mutationEvidence, ...state.evidence];
  const restoredDeltaIds = new Set(records.flatMap((item) => item.kind === "workspace_delta"
    && item.data.checkpointId === checkpointId ? [item.evidenceId] : []));
  const prune = (items: readonly EvidenceRecord[]): EvidenceRecord[] => items.flatMap((item) => {
    if (item.kind === "workspace_delta" && restoredDeltaIds.has(item.evidenceId)) return [];
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
): Partial<Pick<KernelState, "taskControl" | "messages">> {
  const repair = state.taskControl.obligation;
  const protectedOrTerminal = repair?.kind === "completion_evidence" && repair.stage === "terminal"
    || repair?.kind === "terminal_resolution";
  if (!protectedOrTerminal || evidence.some((item) =>
    isCompletionReferenceableEvidence(item, state.sessionId, state.runId))) return {};
  return {
    taskControl: completionEvidenceObligation(state.taskControl, state.revision, "acquire", 0),
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
    if (event.authority !== "runtime" || event.payload.runId !== state.runId) return state;
    return {
      ...state,
      checkpointHead: event.payload,
      ...(requiredStatus === "sealed" ? {
        mutationFrontier: frontierAfterCheckpoint(
          state.mutationFrontier,
          event.payload,
          state.mutationEvidence
        )
      } : {})
    };
  }
  if (event.authority !== "runtime" && event.authority !== "user") return state;
  const checkpointHead = event.payload.runId === state.runId
    ? event.payload : { ...event.payload, runId: state.runId };
  const pruned = pruneRestoredCheckpointEvidence(state, event.payload.checkpointId);
  return recordSemanticWorkspaceRestore({
    ...state,
    ...pruned,
    ...checkpointRepairUpdate(state, pruned.evidence),
    checkpointHead,
    mutationFrontier: frontierAfterCheckpoint(
      state.mutationFrontier,
      checkpointHead,
      pruned.mutationEvidence
    )
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
  const fact = recordSemanticFact(state.taskControl, "process_lifecycle", {
    processId: payload.processId, status: "spawned"
  }, state.revision);
  return {
    ...state,
    activeProcessIds: [...state.activeProcessIds, payload.processId],
    taskControl: fact.control
  };
};

const processSettled: KernelEventReducer = (state, event, payload) => {
  if (event.authority !== "runtime" || typeof payload.processId !== "string") return state;
  const fact = recordSemanticFact(state.taskControl, "process_lifecycle", {
    processId: payload.processId, status: event.type
  }, state.revision);
  return {
    ...state,
    activeProcessIds: state.activeProcessIds.filter((id) => id !== payload.processId),
    taskControl: fact.control
  };
};

export const durableReducers: Partial<Record<AgentEventType, KernelEventReducer>> = {
  "evidence.recorded": evidenceRecorded,
  "usage.recorded": usageRecorded,
  "plan.updated": planUpdated,
  ...durableBudgetReducers,
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
  "process.lost": processSettled,
  "process.handed_off": processSettled
};
