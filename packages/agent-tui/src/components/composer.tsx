import { type AgentRunStatus } from "agent-core";
import { createComposerState, type ComposerState } from "../composer-state.js";
import type { TuiRunMode } from "../mode.js";
import { renderComposer } from "../render/composer.js";

export interface ComposerProps {
  input?: string;
  state?: ComposerState;
  mode?: TuiRunMode;
  running: boolean;
  approvalPending: boolean;
  lastStatus?: AgentRunStatus;
  queuedInstruction?: string | null;
  width?: number;
  color?: boolean;
}

export function Composer(props: ComposerProps): string {
  const state = props.state ?? createComposerState(props.input ?? "");
  return renderComposer({
    state,
    mode: props.mode ?? "build",
    running: props.running,
    approvalPending: props.approvalPending,
    queuedInstruction: props.queuedInstruction,
    width: props.width ?? 80,
    color: props.color,
    compact: false
  });
}
