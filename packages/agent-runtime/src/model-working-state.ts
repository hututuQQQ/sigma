import { createHash } from "node:crypto";
import type { ContextItem } from "agent-protocol";
import { approximateTokens } from "agent-context";
import { semanticActionDebt } from "agent-kernel";
import { currentFrontierReview, frontierValidationReadiness } from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";

const MAX_VISIBLE_ENTRIES = 12;
const MAX_ENTRY_CHARACTERS = 240;

function clipped(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_ENTRY_CHARACTERS
    ? normalized : `${normalized.slice(0, MAX_ENTRY_CHARACTERS - 1)}…`;
}

function digest(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);
}

function boundedLine(label: string, values: readonly string[]): string {
  const visible = values.slice(0, MAX_VISIBLE_ENTRIES).map(clipped);
  return `- ${label}: ${visible.length > 0 ? visible.join(" | ") : "none"}`
    + ` (visible=${visible.length}; total=${values.length}; digest=${digest(values)})`;
}

function distinctFailureFamilies(session: RuntimeSession): string[] {
  const families: string[] = [];
  const add = (value: string | undefined): void => {
    if (value && !families.includes(value)) families.push(value);
  };
  add(session.durable.state.semanticFailureCluster?.family);
  for (const receipt of [...session.durable.state.receipts].reverse()) {
    if (receipt.outcome?.status === "failed" || !receipt.ok) {
      for (const code of [...(receipt.outcome?.diagnosticCodes ?? []), ...receipt.diagnostics]) add(code);
    }
    for (const advisory of receipt.runtimeAdvisories ?? []) add(advisory.code);
    if (families.length >= MAX_VISIBLE_ENTRIES) break;
  }
  return families;
}

/** A bounded, runtime-authored working memory rebuilt from durable state every
 * turn. It keeps current obligations visible independently of lossy history
 * compaction and deliberately excludes raw tool arguments and output. */
export function modelWorkingState(session: RuntimeSession): ContextItem {
  const state = session.durable.state;
  const pendingPlanNodes = state.plan.nodes
    .filter((node) => node.status !== "completed" && node.status !== "cancelled");
  const pendingPlan = pendingPlanNodes.map((node) => `${node.id}:${node.status}:${node.title}`);
  const runtimeManagedRoot = pendingPlanNodes.length === 1
    && pendingPlanNodes[0]?.id === "root"
    && pendingPlanNodes[0].owner.kind === "root"
    && pendingPlanNodes[0].status === "in_progress";
  const latestValidation = frontierValidationReadiness(session).validations.at(-1);
  const latestReview = currentFrontierReview(session);
  const checkpoint = state.checkpointHead
    ? `${state.checkpointHead.checkpointId}:${state.checkpointHead.status}` : "none";
  const validation = latestValidation
    ? `${latestValidation.status}; claim=${latestValidation.data.claim?.kind ?? "untyped"}; frontier=${latestValidation.data.frontierRevision}`
    : "none";
  const review = latestReview
    ? `${latestReview.status}; verdict=${latestReview.data.verdict}; frontier=${latestReview.data.frontierRevision}`
    : "none";
  const lines = [
    "Current working state (runtime-owned, bounded, and authoritative over archived history):",
    `- plan revision: ${state.plan.revision}; active node: ${state.plan.activeNodeId ?? "none"}`,
    boundedLine("pending plan nodes", pendingPlan),
    ...(runtimeManagedRoot ? [
      "- default root completion: runtime-managed after assurance/review gates; do not call update_plan merely to close it or invent evidence references"
    ] : []),
    `- mutation frontier: revision=${state.mutationFrontier.revision}; state=${state.mutationFrontier.currentStateDigest}`,
    boundedLine("net changed paths", state.mutationFrontier.changedPaths),
    `- latest validation: ${validation}`,
    `- latest review: ${review}`,
    `- completion repair: ${state.completionRepair?.kind ?? "none"}`,
    `- action debt: ${semanticActionDebt(state)}`,
    boundedLine("active processes", state.activeProcessIds),
    `- checkpoint: ${checkpoint}`,
    boundedLine("recent distinct failure families", distinctFailureFamilies(session))
  ];
  const content = lines.join("\n");
  return {
    id: `runtime:working-state:${state.runId}:${state.revision}:${state.evidence.length}:${state.receipts.length}`,
    authority: "runtime",
    provenance: "working_state",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_950
  };
}
