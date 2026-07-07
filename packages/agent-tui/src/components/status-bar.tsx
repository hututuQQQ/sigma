import path from "node:path";
import type { ProviderName } from "agent-ai";
import type { AgentEvent, AgentFinalEvidenceMode, AgentHarnessValidationMode, AgentRunResult, PermissionMode, TokenTotals } from "agent-core";
import { formatUsage, eventUsage, oneLine, truncate } from "./formatting.js";

export interface StatusBarProps {
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  validationMode?: AgentHarnessValidationMode;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  running: boolean;
  result: AgentRunResult | null;
  events: AgentEvent[];
  message: string | null;
}

function lastTurn(events: AgentEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turn = events[index].metadata?.turn;
    if (typeof turn === "number") return turn;
  }
  return null;
}

function usageFromEvents(events: AgentEvent[]): Partial<TokenTotals> | undefined {
  const total: Partial<TokenTotals> = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
  let seen = false;
  for (const event of events) {
    if (event.type !== "usage") continue;
    const usage = eventUsage(event);
    if (!usage) continue;
    seen = true;
    total.inputTokens = (total.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    total.cacheTokens = (total.cacheTokens ?? 0) + (usage.cacheTokens ?? 0);
    total.totalTokens = (total.totalTokens ?? 0) + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  }
  return seen ? total : undefined;
}

export function StatusBar(props: StatusBarProps): string {
  const state = props.running ? "running" : props.result ? props.result.status : "idle";
  const finish = props.result ? ` finish=${props.result.finishReason}` : "";
  const turn = props.result?.turns ?? lastTurn(props.events) ?? 0;
  const toolCalls = props.result?.toolCalls ?? props.events.filter((event) => event.type === "tool_start").length;
  const usage = props.result?.usage ?? usageFromEvents(props.events);
  const validation = props.result?.harness
    ? `validation=${props.result.harness.validation_results.some((item) => item.exit_code !== 0) ? "failed" : "ok"}`
    : `validation=${props.validationMode ?? "off"}`;
  const finalEvidence = props.result?.finalGate?.status ?? props.finalEvidenceMode ?? "off";
  const base = path.basename(props.workspacePath) || props.workspacePath;
  const message = props.message ? ` | ${truncate(oneLine(props.message), 90)}` : "";
  return [
    `Sigma TUI | ${state}${finish}`,
    `provider=${props.provider}`,
    `model=${props.model ?? "default"}`,
    `permission=${props.permissionMode}`,
    `workspace=${base} (${props.workspacePath})`,
    `turns=${turn}`,
    `tools=${toolCalls}`,
    usage ? `tokens=${formatUsage(usage)}` : "tokens=unknown",
    validation,
    `final_evidence=${finalEvidence}${message}`
  ].join(" | ");
}
