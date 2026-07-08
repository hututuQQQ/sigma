import path from "node:path";
import type { ProviderName } from "agent-ai";
import {
  DEFAULT_FINAL_EVIDENCE_MODE,
  DEFAULT_VALIDATION_MODE,
  redactSecretText,
  type AgentEvent,
  type AgentFinalEvidenceMode,
  type AgentHarnessValidationMode,
  type AgentRunResult,
  type PermissionMode,
  type SandboxConfig,
  type TokenTotals
} from "agent-core";
import { box } from "../ui/box.js";
import { glyphs, truncateToWidth } from "../ui/theme.js";
import { eventUsage, formatUsage, oneLine } from "./formatting.js";

export interface StatusBarProps {
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  sandbox?: SandboxConfig;
  validationMode?: AgentHarnessValidationMode;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  running: boolean;
  result: AgentRunResult | null;
  events: AgentEvent[];
  message: string | null;
  maxTurns?: number;
  enableMcp?: boolean;
  queuedInstruction?: string | null;
  width?: number;
  color?: boolean;
}

function lastTurn(events: AgentEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turn = events[index].metadata?.turn;
    if (typeof turn === "number") return turn;
  }
  return null;
}

export function usageFromEvents(events: AgentEvent[]): Partial<TokenTotals> | undefined {
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

function validationState(props: StatusBarProps): string {
  if (props.result?.harness) {
    const failed = [...props.result.harness.validation_results, ...props.result.harness.precheck_results]
      .some((item) => item.exit_code !== 0);
    return failed ? "failed" : "ok";
  }
  return props.validationMode ?? DEFAULT_VALIDATION_MODE;
}

function mcpState(result: AgentRunResult | null, enabled?: boolean): string {
  if (result?.mcpServers && result.mcpServers.length > 0) {
    const loaded = result.mcpServers.reduce((sum, server) => sum + server.tools_loaded, 0);
    const failed = result.mcpServers.filter((server) => server.error).length;
    return failed > 0 ? `${loaded} tools/${failed} errors` : `${loaded} tools`;
  }
  return enabled ? "enabled" : "off";
}

function observedToolCalls(events: AgentEvent[]): number {
  const seen = new Set<string>();
  let anonymous = 0;
  for (const event of events) {
    if (event.type !== "tool_queued" && event.type !== "tool_start") continue;
    const callId = typeof event.metadata?.toolCallId === "string" ? event.metadata.toolCallId : "";
    if (callId) seen.add(callId);
    else anonymous += 1;
  }
  return seen.size + anonymous;
}

function sandboxState(sandbox: SandboxConfig | undefined): string {
  if (!sandbox) return "default";
  const network = typeof sandbox.network === "string" ? sandbox.network : sandbox.network?.mode;
  const backend = sandbox.backend && sandbox.backend !== "auto" ? `/${sandbox.backend}` : "";
  return `${sandbox.mode ?? "workspace-write"}${backend}${network ? `:${network}` : ""}`;
}

export function StatusBar(props: StatusBarProps): string {
  const g = glyphs();
  const width = props.width ?? 100;
  const state = props.running ? "running" : props.result ? props.result.status : "idle";
  const finish = props.result ? ` ${props.result.finishReason}` : "";
  const turn = props.result?.turns ?? lastTurn(props.events) ?? 0;
  const turnLimit = props.maxTurns ? `/${props.maxTurns}` : "";
  const toolCalls = props.result?.toolCalls ?? observedToolCalls(props.events);
  const usage = props.result?.usage ?? usageFromEvents(props.events);
  const workspaceBase = path.basename(props.workspacePath) || props.workspacePath;
  const workspace = redactSecretText(props.workspacePath);
  const model = props.model ?? props.result?.model ?? "default";
  const validation = validationState(props);
  const evidence = props.result?.finalGate?.status ?? props.finalEvidenceMode ?? DEFAULT_FINAL_EVIDENCE_MODE;
  const queue = props.queuedInstruction
    ? `queued ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(props.queuedInstruction)), 64)}`
    : "queue empty";
  const message = props.message
    ? `notice ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(props.message)), 96)}`
    : "notice ready";

  return box({
    title: `${g.sigma} Sigma`,
    width,
    variant: "accent",
    color: props.color,
    lines: [
      `repo ${workspaceBase} ${g.separator} path ${workspace}`,
      `${props.provider}/${model} ${g.separator} permission ${props.permissionMode} ${g.separator} sandbox ${sandboxState(props.sandbox)} ${g.separator} state ${state}${finish}`,
      `turns ${turn}${turnLimit} ${g.separator} tools ${toolCalls} ${g.separator} tokens ${usage ? formatUsage(usage) : "unknown"} ${g.separator} validation ${validation} ${g.separator} evidence ${evidence} ${g.separator} mcp ${mcpState(props.result, props.enableMcp)}`,
      `${queue} ${g.separator} ${message}`
    ]
  });
}
