import { createHash } from "node:crypto";
import {
  emptyLongHorizonStateV2,
  type JsonValue,
  type AssuranceResourcePolicyV1,
  type LongHorizonActionOutcomeV1,
  type ModelToolCall,
  type LongHorizonStateV2,
  type ModelMessage,
  type ToolReceipt
} from "agent-protocol";
import { approximateTokens, messageTokens } from "agent-context";
import { currentAuxiliaryUsage } from "./assurance-budget.js";
import type { RuntimeSession } from "./types.js";

interface SettledBatch {
  assistant: ModelMessage;
  calls: NonNullable<ModelMessage["toolCalls"]>;
  receipts: ToolReceipt[];
}
export interface EvidenceAttentionWindowV1 {
  basisDigest: string;
  tokenCount: number;
  tokenLimit: number;
  batchCount: number;
  saturated: boolean;
  outcomeDigest: string;
  representativeOutcomes: LongHorizonActionOutcomeV1[];
}

/**
 * This is an attention/context boundary, not a task-semantic judgement. One
 * window is at least one normal maximum-output turn, scales with provider
 * context, and remains bounded so a very large context model cannot postpone
 * fresh judgement indefinitely.
 */
const MINIMUM_EVIDENCE_ATTENTION_TOKENS = 8_192;
const MAXIMUM_EVIDENCE_ATTENTION_TOKENS = 12_288;
const MAXIMUM_RESULT_ATTENTION_TOKENS = 3_072;
const COMMITMENT_EVIDENCE_KINDS = new Set([
  "workspace_delta", "repository_delta", "validation", "review",
  "user_waiver", "restoration", "checkpoint", "child_outcome"
]);
const SUMMARY_ARGUMENT_KEYS = new Set([
  "command", "executable", "args", "path", "paths", "query", "pattern",
  "purpose", "subjects", "cwd", "offset", "limit", "message"
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function longHorizonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function compactSemanticText(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<uuid>")
    .replace(/\b[0-9a-f]{40,64}\b/giu, "<digest>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?\b/gu, "<timestamp>")
    .replace(/\b\d{6,}\b/gu, "<number>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_200);
}

function latestUserBoundary(messages: readonly ModelMessage[]): number {
  let boundary = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") boundary = index;
  }
  return boundary;
}

export function settledLongHorizonBatches(session: RuntimeSession): SettledBatch[] {
  const messages = session.durable.state.messages;
  const receipts = new Map(session.durable.state.receipts.map((receipt) =>
    [receipt.callId, receipt] as const));
  return messages.slice(latestUserBoundary(messages) + 1)
    .flatMap((message): SettledBatch[] => {
      if (message.role !== "assistant" || !message.toolCalls?.length) return [];
      const matching = message.toolCalls.map((call) => receipts.get(call.id));
      return matching.every((receipt) => receipt !== undefined)
        ? [{
            assistant: message,
            calls: message.toolCalls,
            receipts: matching as ToolReceipt[]
          }]
        : [];
    });
}

function summarizedCallArguments(call: ModelToolCall): string {
  if (!call.arguments || typeof call.arguments !== "object"
    || Array.isArray(call.arguments)) return "";
  const input = call.arguments as Record<string, JsonValue>;
  const projected = Object.fromEntries(Object.entries(input)
    .filter(([key]) => SUMMARY_ARGUMENT_KEYS.has(key))
    .map(([key, value]) => [key, value]));
  const summary = Object.keys(projected).length > 0
    ? projected
    : { argumentKeys: Object.keys(input).sort() };
  return compactSemanticText(JSON.stringify(canonical(summary))).slice(0, 320);
}

function actionOutcome(batch: SettledBatch, index: number): LongHorizonActionOutcomeV1 {
  const callShape = batch.calls.map((call) => ({
    name: call.name,
    arguments: call.arguments
  }));
  const receiptShape = batch.receipts.map((receipt, receiptIndex) => ({
    name: batch.calls[receiptIndex]?.name ?? "unknown",
    ok: receipt.ok,
    effects: [...(receipt.actualEffects ?? receipt.observedEffects)].sort(),
    diagnostics: [...receipt.diagnostics].sort(),
    result: receipt.result ?? null,
    outputDigest: createHash("sha256").update(receipt.output, "utf8").digest("hex")
  }));
  const summary = batch.calls.map((call, receiptIndex) => {
    const receipt = batch.receipts[receiptIndex]!;
    const argumentsSummary = summarizedCallArguments(call);
    const output = compactSemanticText(receipt.output).slice(0, 180);
    return [
      call.name,
      argumentsSummary ? `(${argumentsSummary})` : "",
      `:${receipt.ok ? "ok" : "failed"}`,
      output ? `:${output}` : ""
    ].join("");
  }).join(" | ");
  return {
    batch: index,
    toolNames: batch.calls.map((call) => call.name),
    callDigest: longHorizonDigest(callShape),
    resultDigest: longHorizonDigest(receiptShape),
    summary: summary.slice(0, 1_000)
  };
}

function nonemptyWorkspaceDelta(receipt: ToolReceipt): boolean {
  const delta = receipt.workspaceDelta;
  return Boolean(delta
    && delta.added.length + delta.modified.length + delta.deleted.length > 0);
}

function enclosingContainerMutation(receipt: ToolReceipt): boolean {
  return (receipt.evidence ?? []).some((evidence) => {
    if (evidence.kind !== "diagnostic"
      || !evidence.data
      || typeof evidence.data !== "object"
      || Array.isArray(evidence.data)) return false;
    return (evidence.data as Record<string, unknown>).source
      === "enclosing_container_mutation";
  });
}

function objectiveEvidence(receipt: ToolReceipt): boolean {
  return (receipt.evidence ?? []).some((evidence) =>
    COMMITMENT_EVIDENCE_KINDS.has(evidence.kind));
}

/**
 * Identify objective commitment transitions without deciding whether an
 * experiment was semantically useful. With an active plan, observations and
 * arbitrary mutations consume attention until the plan or evidence advances.
 */
function advancesCommitmentBasis(batch: SettledBatch, activePlan: boolean): boolean {
  return batch.calls.some((call, index) => {
    const receipt = batch.receipts[index]!;
    if (call.name === "update_plan") return receipt.ok;
    if (call.name === "validate" || call.name === "request_review") return true;
    if (activePlan) {
      // The plan is the model-declared work contract. Do not classify paths or
      // commands to decide whether a mutation advanced it; the one permitted
      // strategist reset remains advisory.
      return (receipt.evidence ?? []).some((evidence) =>
        COMMITMENT_EVIDENCE_KINDS.has(evidence.kind)
        && evidence.kind !== "workspace_delta"
        && evidence.kind !== "repository_delta");
    }
    return nonemptyWorkspaceDelta(receipt)
      || enclosingContainerMutation(receipt)
      || objectiveEvidence(receipt)
      || (receipt.actualEffects ?? receipt.observedEffects)
        .some((effect) =>
          effect === "filesystem.write" || effect === "repository.write");
  });
}

function resultAttentionTokens(receipt: ToolReceipt): number {
  return Math.min(MAXIMUM_RESULT_ATTENTION_TOKENS, approximateTokens(receipt.output));
}

function batchAttentionTokens(batch: SettledBatch): number {
  return messageTokens(batch.assistant)
    + batch.receipts.reduce((total, receipt) => total + resultAttentionTokens(receipt), 0);
}

function evidenceAttentionTokenLimit(session: RuntimeSession): number {
  const proportional = Math.floor(
    session.services.gateway.capabilities.contextWindowTokens / 16
  );
  return Math.max(
    MINIMUM_EVIDENCE_ATTENTION_TOKENS,
    Math.min(MAXIMUM_EVIDENCE_ATTENTION_TOKENS, proportional)
  );
}

export function longHorizonCommitmentBasisDigest(
  session: RuntimeSession
): string {
  const state = session.durable.state;
  return longHorizonDigest({
    goalEpoch: state.messages.filter((message) => message.role === "user").length,
    plan: state.plan,
    frontier: state.mutationFrontier,
    evidence: longHorizonRelevantEvidence(session)
  });
}

export function evidenceAttentionWindow(
  session: RuntimeSession
): EvidenceAttentionWindowV1 {
  const batches = settledLongHorizonBatches(session);
  const activePlan = session.durable.state.plan.nodes.some((node) =>
    node.status === "pending" || node.status === "in_progress"
    || node.status === "blocked");
  let lastCommitment = -1;
  for (const [index, batch] of batches.entries()) {
    if (advancesCommitmentBasis(batch, activePlan)) lastCommitment = index;
  }
  const deliberation = batches.slice(lastCommitment + 1);
  const outcomes = deliberation.map((batch, index) =>
    actionOutcome(batch, lastCommitment + index + 2));
  // A strategist is a fresh-context pivot, so the newest bounded evidence is
  // authoritative. Retaining the first observations of a long window caused
  // already-resolved environment facts to compete with current receipts.
  const representativeOutcomes = outcomes.slice(-8);
  const tokenCount = deliberation.reduce((total, batch) =>
    total + batchAttentionTokens(batch), 0);
  const tokenLimit = evidenceAttentionTokenLimit(session);
  return {
    basisDigest: longHorizonCommitmentBasisDigest(session),
    tokenCount,
    tokenLimit,
    batchCount: deliberation.length,
    saturated: tokenCount >= tokenLimit,
    outcomeDigest: longHorizonDigest(outcomes.map((outcome) => ({
      callDigest: outcome.callDigest,
      resultDigest: outcome.resultDigest
    }))),
    representativeOutcomes
  };
}

export function longHorizonRelevantEvidence(session: RuntimeSession): unknown[] {
  const frontier = session.durable.state.mutationFrontier;
  return session.durable.state.evidence.flatMap((evidence): unknown[] => {
    if (evidence.kind === "validation"
      && evidence.data.frontierRevision === frontier.revision
      && evidence.data.stateDigest === frontier.currentStateDigest) {
      return [{
        evidenceId: evidence.evidenceId,
        kind: evidence.kind,
        status: evidence.status,
        summary: evidence.summary,
        intent: evidence.data.intent ?? null,
        runtimeRecord: {
          command: evidence.data.command ?? null,
          exitCode: evidence.data.exitCode ?? null,
          output: evidence.data.output ?? null
        }
      }];
    }
    if (evidence.kind === "review"
      && evidence.data.frontierRevision === frontier.revision
      && evidence.data.stateDigest === frontier.currentStateDigest) {
      return [{
        evidenceId: evidence.evidenceId,
        kind: evidence.kind,
        status: evidence.status,
        verdict: evidence.data.verdict,
        basis: evidence.data.reviewBasisDigest ?? null
      }];
    }
    if (evidence.kind === "user_waiver") {
      return [{
        evidenceId: evidence.evidenceId,
        kind: evidence.kind,
        status: evidence.status,
        scope: evidence.data.scope
      }];
    }
    return [];
  });
}

/**
 * A stable strategist input digest. It is observability/context identity only:
 * no change or non-change in this value triggers a terminal or tool decision.
 */
export function longHorizonProgressBasisDigest(session: RuntimeSession): string {
  const state = session.durable.state;
  return longHorizonDigest({
    goalEpoch: state.messages.filter((message) => message.role === "user").length,
    plan: state.plan,
    frontier: state.mutationFrontier,
    evidence: longHorizonRelevantEvidence(session),
    recentOutcomes: state.longHorizon.recentOutcomes.slice(-4)
  });
}

function policyOf(state: LongHorizonStateV2): AssuranceResourcePolicyV1 {
  const assurance = state.assurance;
  return {
    budgetPercent: assurance.budgetPercent,
    reviewRounds: assurance.reviewRounds,
    repairRounds: assurance.repairRounds,
    reviewerMaxTurns: assurance.reviewerMaxTurns,
    reviewerMaxToolCalls: assurance.reviewerMaxToolCalls,
    repairMaxTurns: assurance.repairMaxTurns,
    repairMaxToolCalls: assurance.repairMaxToolCalls,
    strategistMode: assurance.strategistMode,
    duplicateThreshold: assurance.duplicateThreshold,
    strategyRemainingPercent: assurance.strategyRemainingPercent
  };
}

export function withAccountedAssurance(
  session: RuntimeSession,
  state: LongHorizonStateV2
): LongHorizonStateV2 {
  const usage = currentAuxiliaryUsage(session);
  return {
    ...state,
    assurance: {
      ...state.assurance,
      strategistCalls: Math.min(
        state.assurance.strategistMode === "off" ? 0 : 1,
        usage.strategistCalls
      ),
      reviewerCalls: Math.min(
        state.assurance.reviewRounds,
        usage.reviewerCalls
      ),
      auxiliaryInputTokens: usage.inputTokens,
      auxiliaryOutputTokens: usage.outputTokens,
      auxiliaryCostMicroUsd: usage.costMicroUsd
    }
  };
}

function sameObjectiveOutcome(
  left: LongHorizonActionOutcomeV1 | undefined,
  right: LongHorizonActionOutcomeV1
): boolean {
  return Boolean(left
    && left.callDigest === right.callDigest
    && left.resultDigest === right.resultDigest);
}

export function nextLongHorizonState(session: RuntimeSession): LongHorizonStateV2 {
  const current = withAccountedAssurance(session, session.durable.state.longHorizon);
  const batches = settledLongHorizonBatches(session);
  const goalEpoch = session.durable.state.messages.filter((message) =>
    message.role === "user").length;
  if (current.goalEpoch !== goalEpoch || current.settledBatchCount > batches.length) {
    const reset = emptyLongHorizonStateV2(policyOf(current));
    return withAccountedAssurance(session, {
      ...reset,
      goalEpoch,
      settledBatchCount: batches.length
    });
  }
  if (current.settledBatchCount === batches.length) return current;
  let next = { ...current };
  for (let index = current.settledBatchCount; index < batches.length; index += 1) {
    const batch = batches[index]!;
    const outcome = actionOutcome(batch, index + 1);
    const prior = next.recentOutcomes.at(-1);
    const duplicateStreak = sameObjectiveOutcome(prior, outcome)
      ? next.duplicateStreak + 1
      : 1;
    next = {
      ...next,
      settledBatchCount: index + 1,
      recentOutcomes: [...next.recentOutcomes, outcome].slice(-8),
      duplicateStreak,
      strategyRequested: next.strategyRequested
        || batch.calls.some((call) => call.name === "request_strategy")
    };
  }
  return next;
}
