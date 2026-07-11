import type { ToolDescriptor } from "agent-protocol";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

export function profileAllowsTool(session: Pick<RuntimeSession, "profile">, descriptor: ToolDescriptor): boolean {
  const profile = session.profile?.profile;
  if (!profile) return true;
  if (profile.toolDeny.includes(descriptor.name)) return false;
  return profile.toolAllow === null || profile.toolAllow.includes(descriptor.name);
}

export function profilePermissionMode(
  options: Pick<RuntimeOptions, "permissionMode">,
  session: Pick<RuntimeSession, "profile">
): "ask" | "auto" | "deny" {
  const configured = options.permissionMode ?? "ask";
  const profile = session.profile?.profile.permissionMode ?? configured;
  const rank = { deny: 0, ask: 1, auto: 2 } as const;
  return rank[profile] <= rank[configured] ? profile : configured;
}
