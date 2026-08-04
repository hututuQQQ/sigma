import { createHash } from "node:crypto";
import {
  emptyLongHorizonState,
  type JsonValue,
  type AssuranceResourcePolicy,
  type LongHorizonActionOutcome,
  type ModelToolCall,
  type LongHorizonState,
  type ModelMessage,
  type ToolReceipt
} from "agent-protocol";
import { approximateTokens, messageTokens } from "agent-context";
import { currentAuxiliaryUsage } from "./assurance-budget.js";
import {
  batchMadeMarginalProgress,
  emptyMarginalProgressHistory,
  recordMarginalProgress,
  type ProgressBatch
} from "./long-horizon-progress.js";
import type { RuntimeSession } from "./types.js";

type SettledBatch = ProgressBatch;
export interface EvidenceAttentionWindow {
  basisDigest: string;
  tokenCount: number;
  tokenLimit: number;
  batchCount: number;
  saturated: boolean;
  outcomeDigest: string;
  representativeOutcomes: LongHorizonActionOutcome[];
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

function actionOutcome(batch: SettledBatch, index: number): LongHorizonActionOutcome {
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
): EvidenceAttentionWindow {
  const batches = settledLongHorizonBatches(session);
  let lastCommitment = -1;
  const progressHistory = emptyMarginalProgressHistory();
  for (const [index, batch] of batches.entries()) {
    const outcome = actionOutcome(batch, index + 1);
    if (batchMadeMarginalProgress(batch, outcome, progressHistory)) {
      lastCommitment = index;
    }
    recordMarginalProgress(progressHistory, batch, outcome);
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

function policyOf(state: LongHorizonState): AssuranceResourcePolicy {
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
  state: LongHorizonState
): LongHorizonState {
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

export function nextLongHorizonState(session: RuntimeSession): LongHorizonState {
  const current = withAccountedAssurance(session, session.durable.state.longHorizon);
  const batches = settledLongHorizonBatches(session);
  const goalEpoch = session.durable.state.messages.filter((message) =>
    message.role === "user").length;
  if (current.goalEpoch !== goalEpoch || current.settledBatchCount > batches.length) {
    const reset = emptyLongHorizonState(policyOf(current));
    return withAccountedAssurance(session, {
      ...reset,
      goalEpoch,
      settledBatchCount: batches.length
    });
  }
  if (current.settledBatchCount === batches.length) return current;
  let next = { ...current };
  const progressHistory = emptyMarginalProgressHistory();
  const historyStart = Math.max(0, current.settledBatchCount - 8);
  for (let index = historyStart; index < current.settledBatchCount; index += 1) {
    const batch = batches[index]!;
    recordMarginalProgress(progressHistory, batch, actionOutcome(batch, index + 1));
  }
  for (let index = current.settledBatchCount; index < batches.length; index += 1) {
    const batch = batches[index]!;
    const outcome = actionOutcome(batch, index + 1);
    const progressed = batchMadeMarginalProgress(batch, outcome, progressHistory);
    const duplicateStreak = progressed ? 0 : next.duplicateStreak + 1;
    recordMarginalProgress(progressHistory, batch, outcome);
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
