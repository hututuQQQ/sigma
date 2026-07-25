import {
  KERNEL_STATE_VERSION,
  emptyLongHorizonStateV2,
  emptyReasoningTrajectoryStateV1,
  LEGACY_KERNEL_STATE_VERSION_V6,
  LEGACY_KERNEL_STATE_VERSION_V7,
  LEGACY_KERNEL_STATE_VERSION_V8,
  LEGACY_KERNEL_STATE_VERSION_V9
} from "agent-protocol";
import {
  assertKernelInvariants,
  decodeLegacyKernelStateV5,
  isKernelState,
  LEGACY_V5_TASK_CONTROL_KEYS,
  type KernelState
} from "agent-kernel";

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacyPendingCompletionCallIds(raw: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const pending = Array.isArray(raw.pendingTools) ? raw.pendingTools : [];
  for (const value of pending) {
    const request = plainRecord(plainRecord(value).request);
    if (request.name === "runtime_finalize" && typeof request.callId === "string") {
      ids.push(request.callId);
    }
  }
  return ids;
}

function legacyMessageCompletionCallIds(raw: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  for (const value of messages) {
    const message = plainRecord(value);
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
    for (const valueCall of message.toolCalls) {
      const call = plainRecord(valueCall);
      if (call.name === "runtime_finalize" && typeof call.id === "string") ids.push(call.id);
    }
  }
  return ids;
}

function legacyCompletionCallIds(raw: Record<string, unknown>): Set<string> {
  return new Set([
    ...legacyPendingCompletionCallIds(raw),
    ...legacyMessageCompletionCallIds(raw)
  ]);
}

function migrateLegacyMessages(
  raw: Record<string, unknown>,
  completionDraft: string | undefined,
  completionCallIds: ReadonlySet<string>,
  terminal: boolean
): KernelState["messages"] {
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const message = value as Record<string, unknown>;
    if (message.role === "tool" && typeof message.toolCallId === "string"
      && completionCallIds.has(message.toolCallId)) return [];
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) return [value];
    const toolCalls = message.toolCalls.filter((call) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) return true;
      return (call as Record<string, unknown>).name !== "runtime_finalize";
    });
    if (toolCalls.length === 0 && message.toolCalls.length > 0
      && !String(message.content ?? "").trim()) return [];
    return [{
      ...message,
      ...(toolCalls.length > 0 ? { toolCalls } : { toolCalls: undefined })
    }];
  }) as KernelState["messages"];
  if (terminal || !completionDraft
    || messages.some((message) =>
      message.role === "assistant" && message.content.trim() === completionDraft)) return messages;
  return [...messages, { role: "assistant", content: completionDraft }];
}

function migratedPendingTools(
  raw: Record<string, unknown>,
  completionCallIds: ReadonlySet<string>
): KernelState["pendingTools"] {
  if (!Array.isArray(raw.pendingTools)) return [];
  return (raw.pendingTools as KernelState["pendingTools"]).filter((item) =>
    !completionCallIds.has(item.request.callId) && item.request.name !== "runtime_finalize");
}

function phaseAfterLegacyCompletion(
  raw: Record<string, unknown>,
  pendingTools: KernelState["pendingTools"],
  hadProtectedCompletion: boolean
): KernelState["phase"] {
  if (raw.phase === "terminal") return "terminal";
  if (!hadProtectedCompletion) return raw.phase as KernelState["phase"];
  if (pendingTools.some((item) => item.approval === "pending")) return "needs_input";
  if (pendingTools.some((item) => item.started)) return "tool_in_flight";
  return pendingTools.length > 0 ? "tool_pending" : "ready_model";
}

function hasProtectedLegacyCompletion(
  raw: Record<string, unknown>,
  completionDraft: string | undefined,
  completionCallIds: ReadonlySet<string>
): boolean {
  const proposed = plainRecord(raw.proposedOutcome);
  return Boolean(completionDraft
    || completionCallIds.size > 0
    || proposed.kind === "completed");
}

function migratedToolCallIds(
  raw: Record<string, unknown>,
  completionCallIds: ReadonlySet<string>,
  pendingTools: KernelState["pendingTools"]
): string[] {
  if (Array.isArray(raw.toolCallIds)) {
    return (raw.toolCallIds as string[]).filter((id) => !completionCallIds.has(id));
  }
  const receiptIds = (Array.isArray(raw.receipts) ? raw.receipts : []).flatMap((value) => {
    const callId = plainRecord(value).callId;
    return typeof callId === "string" ? [callId] : [];
  });
  return [...new Set([
    ...receiptIds,
    ...pendingTools.map((pending) => pending.request.callId)
  ])];
}

function validatedState(state: KernelState, sessionId: string): KernelState | undefined {
  if (!isKernelState(state) || state.sessionId !== sessionId) return undefined;
  try {
    assertKernelInvariants(state);
    return state;
  } catch {
    return undefined;
  }
}

function legacyAuditEvidence(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const evidence = value as Record<string, unknown>;
  if (evidence.kind !== "review") return value;
  const data = plainRecord(evidence.data);
  // A review produced before Event V9 did not use the active-review V3
  // provenance contract. Preserve it for audit, but make it impossible for a
  // resumed V10 completion gate to mistake it for current approval.
  return {
    ...evidence,
    data: {
      ...data,
      schemaVersion: 2,
      reviewRequestId: undefined
    }
  };
}

function legacyAuditEvidenceList(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(legacyAuditEvidence) : [];
}

function migrateV7Snapshot(
  raw: Record<string, unknown>,
  sessionId: string
): KernelState | undefined {
  return validatedState({
    ...raw,
    schemaVersion: KERNEL_STATE_VERSION,
    promptState: {
      schemaVersion: 2,
      sectionDigests: {},
      budgetBand: 100
    },
    lengthRecovery: {
      schemaVersion: 1,
      mode: raw.lastModelFinishReason === "length" && raw.lastModelHadToolCalls === true
        ? "continue_after_tools"
        : raw.lastModelFinishReason === "length"
          ? "action_required"
          : "none",
      attempts: Number.isSafeInteger(raw.consecutiveLengthFinishes)
        ? Number(raw.consecutiveLengthFinishes)
        : 0
    },
    reviewReceipts: [],
    evidence: legacyAuditEvidenceList(raw.evidence),
    mutationEvidence: legacyAuditEvidenceList(raw.mutationEvidence),
    longHorizon: emptyLongHorizonStateV2(),
    reasoningTrajectory: emptyReasoningTrajectoryStateV1()
  } as unknown as KernelState, sessionId);
}

function migrateV8Snapshot(
  raw: Record<string, unknown>,
  sessionId: string
): KernelState | undefined {
  return validatedState({
    ...raw,
    schemaVersion: KERNEL_STATE_VERSION,
    promptState: {
      schemaVersion: 2,
      sectionDigests: {},
      budgetBand: 100
    },
    reviewReceipts: [],
    evidence: legacyAuditEvidenceList(raw.evidence),
    mutationEvidence: legacyAuditEvidenceList(raw.mutationEvidence),
    longHorizon: emptyLongHorizonStateV2(),
    reasoningTrajectory: emptyReasoningTrajectoryStateV1()
  } as unknown as KernelState, sessionId);
}

function migrateV6Snapshot(
  raw: Record<string, unknown>,
  sessionId: string
): KernelState | undefined {
  return validatedState({
    ...raw,
    schemaVersion: KERNEL_STATE_VERSION,
    lastModelFinishReason: undefined,
    consecutiveLengthFinishes: 0,
    consecutiveLengthNoAction: 0,
    lastModelHadToolCalls: false,
    lengthRecovery: { schemaVersion: 1, mode: "none", attempts: 0 },
    reviewReceipts: [],
    evidence: legacyAuditEvidenceList(raw.evidence),
    mutationEvidence: legacyAuditEvidenceList(raw.mutationEvidence),
    promptState: {
      schemaVersion: 2,
      sectionDigests: {},
      budgetBand: 100
    },
    longHorizon: emptyLongHorizonStateV2(),
    reasoningTrajectory: emptyReasoningTrajectoryStateV1()
  } as unknown as KernelState, sessionId);
}

export function migrateLegacySnapshot(
  raw: Record<string, unknown>,
  sessionId: string
): KernelState | undefined {
  if (raw.schemaVersion === LEGACY_KERNEL_STATE_VERSION_V9) {
    return validatedState({
      ...raw,
      schemaVersion: KERNEL_STATE_VERSION,
      // V9's semantic 4/8/6 state is intentionally not migrated. The next
      // model turn receives one complete V10 runtime frame.
      promptState: {
        schemaVersion: 2,
        sectionDigests: {},
        budgetBand: 100
      },
      reviewReceipts: [],
      evidence: legacyAuditEvidenceList(raw.evidence),
      mutationEvidence: legacyAuditEvidenceList(raw.mutationEvidence),
      longHorizon: emptyLongHorizonStateV2()
    } as unknown as KernelState, sessionId);
  }
  if (raw.schemaVersion === LEGACY_KERNEL_STATE_VERSION_V8) {
    return migrateV8Snapshot(raw, sessionId);
  }
  if (raw.schemaVersion === LEGACY_KERNEL_STATE_VERSION_V7) {
    return migrateV7Snapshot(raw, sessionId);
  }
  if (raw.schemaVersion === LEGACY_KERNEL_STATE_VERSION_V6) {
    return migrateV6Snapshot(raw, sessionId);
  }
  const legacy = decodeLegacyKernelStateV5(raw);
  if (!legacy) return undefined;
  const completionCallIds = legacyCompletionCallIds(raw);
  const terminal = raw.phase === "terminal";
  const hadProtectedCompletion = hasProtectedLegacyCompletion(
    raw, legacy.completionDraft, completionCallIds
  );
  const pendingTools = migratedPendingTools(raw, completionCallIds);
  const migrated = { ...raw };
  for (const key of LEGACY_V5_TASK_CONTROL_KEYS) delete migrated[key];
  const state = {
    ...migrated,
    schemaVersion: KERNEL_STATE_VERSION,
    messages: migrateLegacyMessages(
      raw, legacy.completionDraft, completionCallIds, terminal
    ),
    pendingTools,
    toolCallIds: migratedToolCallIds(raw, completionCallIds, pendingTools),
    activeProcessIds: Array.isArray(raw.activeProcessIds) ? raw.activeProcessIds : [],
    lastModelFinishReason: undefined,
    consecutiveLengthFinishes: 0,
    consecutiveLengthNoAction: 0,
    lastModelHadToolCalls: false,
    lengthRecovery: { schemaVersion: 1, mode: "none", attempts: 0 },
    reviewReceipts: [],
    evidence: legacyAuditEvidenceList(raw.evidence),
    mutationEvidence: legacyAuditEvidenceList(raw.mutationEvidence),
    promptState: {
      schemaVersion: 2,
      sectionDigests: {},
      budgetBand: 100
    },
    longHorizon: emptyLongHorizonStateV2(),
    reasoningTrajectory: emptyReasoningTrajectoryStateV1(),
    phase: phaseAfterLegacyCompletion(raw, pendingTools, hadProtectedCompletion),
    ...(terminal ? {} : {
      proposedOutcome: undefined,
      ...(raw.phase === "needs_input" && !hadProtectedCompletion
        ? {}
        : { outcome: undefined })
    })
  } as unknown as KernelState;
  return validatedState(state, sessionId);
}
