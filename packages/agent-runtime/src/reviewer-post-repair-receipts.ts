import { createHash } from "node:crypto";
import type { ToolEffect } from "agent-protocol";
import type { ReviewerReceiptSummary } from "./reviewer-contracts.js";
import type { RuntimeSession } from "./types.js";

const MAX_POST_REVIEW_RECEIPTS = 16;
const MAX_SESSION_RECEIPTS = 24;
const MAX_ARGUMENT_PREVIEW = 1_024;
const MAX_OUTPUT_PREVIEW = 2_048;
const NON_SUBSTANTIVE_FAILURES = new Set([
  "review_scope_too_large",
  "review_protocol_invalid",
  "review_unavailable"
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedPreview(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const edge = Math.max(1, Math.floor((maximum - 32) / 2));
  return `${value.slice(0, edge)}\n[... omitted ...]\n${value.slice(-edge)}`;
}

function latestSubstantiveReviewAt(session: RuntimeSession): number | undefined {
  const latest = session.durable.state.evidence.filter((item) =>
    item.kind === "review"
    && item.runId === session.durable.runId
    && item.data.failureKind === undefined
    && !NON_SUBSTANTIVE_FAILURES.has(item.data.failureCode ?? "")).at(-1);
  if (!latest) return undefined;
  const timestamp = Date.parse(latest.createdAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function modelCalls(session: RuntimeSession): Map<string, {
  name: string;
  arguments: unknown;
}> {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  for (const message of session.durable.state.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      calls.set(call.id, { name: call.name, arguments: call.arguments });
    }
  }
  return calls;
}

function relevantEffects(effects: readonly ToolEffect[]): boolean {
  return effects.includes("filesystem.read")
    || effects.includes("validation")
    || effects.includes("process.handoff")
    || effects.some((effect) =>
      effect === "process.spawn" || effect.startsWith("process.spawn."));
}

function receiptSummaries(
  session: RuntimeSession,
  receipts: RuntimeSession["durable"]["state"]["receipts"]
): ReviewerReceiptSummary[] {
  const calls = modelCalls(session);
  return receipts.filter((receipt) => {
    const effects = receipt.actualEffects ?? receipt.observedEffects;
    return relevantEffects(effects) && calls.has(receipt.callId);
  }).map((receipt) => {
    const call = calls.get(receipt.callId)!;
    const argumentsJson = JSON.stringify(call.arguments ?? null);
    const resultJson = JSON.stringify(receipt.result ?? null);
    const effects = [...new Set(
      receipt.actualEffects ?? receipt.observedEffects
    )] as ToolEffect[];
    return {
      callId: receipt.callId,
      toolName: call.name,
      ok: receipt.ok,
      argumentsDigest: sha256(argumentsJson),
      argumentsPreview: boundedPreview(argumentsJson, MAX_ARGUMENT_PREVIEW),
      resultDigest: sha256(`${receipt.output}\0${resultJson}`),
      outputPreview: boundedPreview(receipt.output, MAX_OUTPUT_PREVIEW),
      effects,
      diagnostics: receipt.diagnostics.slice(0, 16),
      evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId),
      artifactIds: [
        ...receipt.artifacts,
        ...(receipt.artifactRefs ?? []).map((item) => item.artifactId)
      ],
      completedAt: receipt.completedAt
    };
  });
}

/**
 * Surface bounded objective receipts from the whole main session to the first
 * reviewer. These are authenticated execution leads, not semantic approval.
 */
export function sessionReceiptSummaries(
  session: RuntimeSession
): ReviewerReceiptSummary[] {
  return receiptSummaries(session, session.durable.state.receipts)
    .filter((receipt) => receipt.toolName.startsWith("process_")
      || receipt.toolName === "environment_process_spawn")
    .slice(-MAX_SESSION_RECEIPTS);
}

/**
 * Surface bounded, durable repair receipts to the next reviewer as leads.
 * They refresh review basis but are not themselves semantic approval: the
 * reviewer must still execute an authentic current-frontier check.
 */
export function postReviewReceiptSummaries(
  session: RuntimeSession
): ReviewerReceiptSummary[] {
  const reviewAt = latestSubstantiveReviewAt(session);
  if (reviewAt === undefined) return [];
  const receipts = session.durable.state.receipts.filter((receipt) => {
    const completedAt = Date.parse(receipt.completedAt);
    return Number.isFinite(completedAt)
      && completedAt > reviewAt
  }).slice(-MAX_POST_REVIEW_RECEIPTS);
  return receiptSummaries(session, receipts);
}
