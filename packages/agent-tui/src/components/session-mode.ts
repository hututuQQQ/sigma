import type { RunMode } from "agent-protocol";
import type { TuiAppOptions } from "./types.js";

export function ffiReady(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major! > 26 || major === 26 && minor! >= 4;
  return supported && (process.execArgv.includes("--experimental-ffi")
    || (process.env.NODE_OPTIONS ?? "").split(/\s+/u).includes("--experimental-ffi"));
}

export async function assertDurableSessionMode(
  runtime: TuiAppOptions["runtime"],
  sessionId: string,
  expectedMode: RunMode
): Promise<void> {
  for await (const event of runtime.sessionEvents(sessionId)) {
    if (event.type !== "session.created") continue;
    const createdMode = (event.payload as { mode?: unknown }).mode;
    if (createdMode !== "analyze" && createdMode !== "change") {
      throw Object.assign(new Error(`Session '${sessionId}' has an invalid durable mode.`), {
        code: "session_creation_event_invalid"
      });
    }
    if (createdMode !== expectedMode) {
      throw Object.assign(new Error(
        `Session '${sessionId}' was created in ${createdMode} mode, not ${expectedMode} mode.`
      ), { code: "initial_mode_mismatch" });
    }
    return;
  }
  throw Object.assign(new Error(`Session '${sessionId}' has no durable creation event.`), {
    code: "session_creation_event_missing"
  });
}
