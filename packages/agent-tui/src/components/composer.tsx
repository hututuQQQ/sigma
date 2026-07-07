import type { AgentRunStatus } from "agent-core";

export interface ComposerProps {
  input: string;
  running: boolean;
  approvalPending: boolean;
  lastStatus?: AgentRunStatus;
}

export function Composer(props: ComposerProps): string {
  const prompt = props.approvalPending
    ? "approval [y/n/a]> "
    : props.running
      ? "sigma (running)> "
      : props.lastStatus === "completed"
        ? "sigma (done)> "
        : props.lastStatus === "stopped"
          ? "sigma (stopped)> "
          : props.lastStatus === "error"
            ? "sigma (error)> "
            : "sigma> ";
  return `${prompt}${props.input}`;
}
