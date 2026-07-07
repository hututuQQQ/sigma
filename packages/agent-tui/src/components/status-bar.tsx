import type { ProviderName } from "agent-ai";
import type { AgentRunResult, PermissionMode } from "agent-core";

export interface StatusBarProps {
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  running: boolean;
  result: AgentRunResult | null;
  message: string | null;
}

export function StatusBar(props: StatusBarProps): string {
  const state = props.running ? "running" : props.result ? props.result.status : "idle";
  const finish = props.result ? ` finish=${props.result.finishReason}` : "";
  const message = props.message ? ` | ${props.message}` : "";
  return [
    `Sigma TUI | ${state}${finish}`,
    `provider=${props.provider}`,
    `model=${props.model ?? "default"}`,
    `permission=${props.permissionMode}`,
    `workspace=${props.workspacePath}${message}`
  ].join(" | ");
}
