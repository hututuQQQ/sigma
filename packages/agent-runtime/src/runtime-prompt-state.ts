import { createHash } from "node:crypto";
import type {
  BudgetAmounts,
  ContextItem,
  RuntimeBudgetBand,
  RuntimePromptState
} from "agent-protocol";
import { approximateTokens, fitApproximateTokens } from "agent-context";
import type { RuntimeSession } from "./types.js";
import { longHorizonLedger } from "./long-horizon-ledger.js";

export const MAX_RUNTIME_PROMPT_FRAME_TOKENS = 8_192;
const MAX_RUNTIME_PROMPT_FRAME_CONTENT_TOKENS = MAX_RUNTIME_PROMPT_FRAME_TOKENS - 64;

type SectionName = keyof RuntimePromptState["sectionDigests"];

export interface RuntimePromptSectionInput {
  repository: readonly ContextItem[];
  completion: ContextItem;
  plan: ContextItem;
  longHorizon?: ContextItem;
  turnOnly?: readonly ContextItem[];
}

export interface RuntimePromptFrame {
  items: ContextItem[];
  promptState: RuntimePromptState;
  frameMode: "full" | "delta";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sectionItem(
  section: SectionName,
  items: readonly ContextItem[],
  maximumTokens: number
): ContextItem {
  const full = items.map((item) => `[${item.provenance}]\n${item.content}`).join("\n\n");
  const sectionDigest = digest(items.map((item) => item.cacheKey ?? digest(item.content)).join(":"));
  const content = fitApproximateTokens(
    `${full}\nRuntime section digest: ${sectionDigest}`,
    maximumTokens
  );
  return {
    id: `runtime:state:${section}:${sectionDigest}`,
    authority: "runtime",
    provenance: `runtime_state:${section}`,
    content,
    tokenCount: approximateTokens(content),
    priority: section === "repository" ? 9_700
      : section === "completion" ? 9_900
        : section === "plan" ? 9_800
          : section === "longHorizon" ? 9_850 : 10_000,
    cacheKey: sectionDigest
  };
}

function remainingRatio(
  session: RuntimeSession,
  available: BudgetAmounts,
  dimension: keyof BudgetAmounts
): number {
  const limit = session.durable.state.budget.limits[dimension];
  return limit <= 0 ? 0 : available[dimension] / limit;
}

export function budgetBand(
  session: RuntimeSession,
  available: BudgetAmounts
): RuntimeBudgetBand {
  const minimum = Math.min(...(
    ["inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"] as const
  ).map((dimension) => remainingRatio(session, available, dimension)));
  if (minimum <= 0) return 0;
  if (minimum <= 0.10) return 10;
  if (minimum <= 0.25) return 25;
  if (minimum <= 0.50) return 50;
  return 100;
}

function budgetItem(band: RuntimeBudgetBand): ContextItem {
  const label = band === 100 ? "above 50%"
    : band === 50 ? "at or below 50%"
      : band === 25 ? "at or below 25%"
        : band === 10 ? "at or below 10%" : "exhausted";
  const content = [
    `At least one non-time hard resource is ${label}.`,
    "Use read_budget only when exact remaining amounts materially affect the next decision."
  ].join("\n");
  const itemDigest = digest(`budget-band:${band}`);
  return {
    id: `runtime:state:budget:${itemDigest}`,
    authority: "runtime",
    provenance: "runtime_state:budget",
    content,
    tokenCount: approximateTokens(content),
    priority: 10_000,
    cacheKey: itemDigest
  };
}

function turnOnlyItem(item: ContextItem, remainingTokens: number): ContextItem | undefined {
  if (remainingTokens <= 0) return undefined;
  const content = fitApproximateTokens(
    `[turn-only notice; applies only to the immediately following assistant turn]\n${item.content}`,
    remainingTokens
  );
  return {
    ...item,
    id: `runtime:turn-only:${item.id}`,
    provenance: `turn_only:${item.provenance}`,
    content,
    tokenCount: approximateTokens(content)
  };
}

export function materializeRuntimePromptFrame(
  session: RuntimeSession,
  available: BudgetAmounts,
  sections: RuntimePromptSectionInput
): RuntimePromptFrame {
  const repository = sectionItem("repository", sections.repository, 4_096);
  const completion = sectionItem("completion", [sections.completion], 2_048);
  const plan = sectionItem("plan", [sections.plan], 1_024);
  const longHorizon = sectionItem(
    "longHorizon",
    [sections.longHorizon ?? longHorizonLedger(session)],
    1_536
  );
  const band = budgetBand(session, available);
  const budget = budgetItem(band);
  const candidates = { repository, completion, plan, longHorizon, budget };
  const previous = session.durable.state.promptState;
  const archiveSourceDigest = session.durable.state.contextArchive?.sourceDigest;
  const full = Object.keys(previous.sectionDigests).length === 0
    || previous.archiveSourceDigest !== archiveSourceDigest;
  const nextDigests: RuntimePromptState["sectionDigests"] = {
    repository: repository.cacheKey!,
    completion: completion.cacheKey!,
    plan: plan.cacheKey!,
    longHorizon: longHorizon.cacheKey!,
    budget: budget.cacheKey!
  };
  const selected = (Object.entries(candidates) as Array<[SectionName, ContextItem]>)
    .filter(([name, item]) => full || previous.sectionDigests[name] !== item.cacheKey)
    .map(([, item]) => item);
  let used = selected.reduce((total, item) => total + item.tokenCount, 0);
  for (const item of sections.turnOnly ?? []) {
    const bounded = turnOnlyItem(item, MAX_RUNTIME_PROMPT_FRAME_CONTENT_TOKENS - used);
    if (!bounded) break;
    selected.push(bounded);
    used += bounded.tokenCount;
  }
  return {
    items: selected,
    promptState: {
      schemaVersion: 1,
      sectionDigests: nextDigests,
      budgetBand: band,
      ...(archiveSourceDigest ? { archiveSourceDigest } : {})
    },
    frameMode: full ? "full" : "delta"
  };
}
