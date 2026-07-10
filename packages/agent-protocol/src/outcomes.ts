import type { JsonValue } from "./json.js";

export type RunMode = "analyze" | "change";

export type RunOutcome =
  | { kind: "completed"; message: string; evidence: JsonValue[] }
  | { kind: "needs_input"; requestId: string; message: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "recoverable_failure"; code: string; message: string; resumeToken?: string }
  | { kind: "fatal"; code: string; message: string };

export type RunCommand =
  | { type: "submit"; sessionId: string; text: string; mode?: RunMode }
  | { type: "steer"; sessionId: string; text: string }
  | { type: "follow_up"; sessionId: string; text: string }
  | { type: "approve"; sessionId: string; requestId: string; decision: "allow" | "deny" | "always_allow" }
  | { type: "cancel"; sessionId: string; reason?: string }
  | { type: "resume"; sessionId: string };
