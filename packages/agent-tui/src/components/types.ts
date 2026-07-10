import type { PresentationState } from "agent-presentation";
import type { RunMode, RuntimeClient } from "agent-protocol";

export interface TuiAppOptions {
  runtime: RuntimeClient;
  workspace: string;
  mode?: RunMode;
  sessionId?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  maxFps?: number;
}

export interface TuiSnapshot {
  workspace: string;
  sessionId?: string;
  mode: RunMode;
  presentation: PresentationState;
  notice?: { message: string; error: boolean };
}

export type SubmissionKind = "default" | "follow_up";

export interface TuiViewActions {
  submit(text: string, kind: SubmissionKind): Promise<void>;
  approve(requestId: string, decision: "allow" | "deny" | "always_allow"): Promise<void>;
  interrupt(): Promise<void>;
  newSession(): Promise<void>;
  setMode(mode: RunMode): void;
  stop(): void;
  userAction(): void;
}
