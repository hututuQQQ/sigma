import {
  KERNEL_STATE_VERSION,
  LEGACY_KERNEL_STATE_VERSION_V6
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

export function migrateLegacySnapshot(
  raw: Record<string, unknown>,
  sessionId: string
): KernelState | undefined {
  if (raw.schemaVersion === LEGACY_KERNEL_STATE_VERSION_V6) {
    return validatedState({
      ...raw,
      schemaVersion: KERNEL_STATE_VERSION,
      lastModelFinishReason: undefined,
      consecutiveLengthFinishes: 0,
      consecutiveLengthNoAction: 0,
      lastModelHadToolCalls: false
    } as unknown as KernelState, sessionId);
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
