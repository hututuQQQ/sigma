import { redactSecretText, type AgentRunStatus } from "agent-core";
import { box } from "../ui/box.js";
import { glyphs, truncateToWidth } from "../ui/theme.js";
import { oneLine } from "./formatting.js";

export interface ComposerProps {
  input: string;
  running: boolean;
  approvalPending: boolean;
  lastStatus?: AgentRunStatus;
  queuedInstruction?: string | null;
  width?: number;
  color?: boolean;
}

function promptFor(props: ComposerProps): string {
  if (props.approvalPending) return "approval [y/n/a]> ";
  if (props.running) return "sigma draft> ";
  if (props.lastStatus === "completed") return "sigma done> ";
  if (props.lastStatus === "stopped") return "sigma stopped> ";
  if (props.lastStatus === "error") return "sigma error> ";
  return "sigma> ";
}

export function Composer(props: ComposerProps): string {
  const g = glyphs();
  const width = props.width ?? 80;
  const inputLines = redactSecretText(props.input).split(/\r?\n/);
  const prompt = promptFor(props);
  const status = props.approvalPending
    ? "approval waiting"
    : props.queuedInstruction
      ? `queued ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(props.queuedInstruction)), Math.max(20, width - 18))}`
      : props.running
        ? "run active; Enter queues this draft for the next run"
        : "ready";
  const lines = [
    `hints: / commands ${g.separator} F1 help ${g.separator} Ctrl+J newline ${g.separator} Up/Down history ${g.separator} Ctrl+D diff ${g.separator} Ctrl+T tools`,
    `state: ${status}`,
    `${prompt}${inputLines[0] ?? ""}`,
    ...inputLines.slice(1).map((line) => `...> ${line}`)
  ];
  return box({
    title: `${g.sigma} Composer`,
    width,
    color: props.color,
    lines
  });
}
