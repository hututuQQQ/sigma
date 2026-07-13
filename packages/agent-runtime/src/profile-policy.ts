import type { ToolDescriptor } from "agent-protocol";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

export function profileAllowsTool(
  session: Pick<RuntimeSession, "services">,
  descriptor: ToolDescriptor
): boolean {
  const profile = session.services.profile?.profile;
  if (!profile) return true;
  if (profile.toolDeny.includes(descriptor.name)) return false;
  return profile.toolAllow === null || profile.toolAllow.includes(descriptor.name);
}

export function profilePermissionMode(
  options: Pick<RuntimeOptions, "permissionMode">,
  session: Pick<RuntimeSession, "services">
): "ask" | "auto" | "deny" {
  const configured = options.permissionMode ?? "ask";
  const profile = session.services.profile?.profile.permissionMode ?? configured;
  const rank = { deny: 0, ask: 1, auto: 2 } as const;
  return rank[profile] <= rank[configured] ? profile : configured;
}
