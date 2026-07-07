import { redactSecretText, type PermissionRequest } from "agent-core";

export function ApprovalPrompt(request: PermissionRequest | null): string {
  if (!request) return "";
  return [
    "Approval required",
    "  The run is paused. Press one key to continue; Enter is not required.",
    "  y = allow once    n = deny    a = always allow this kind of request",
    "",
    `  tool: ${request.toolName}`,
    `  risk: ${request.risk}`,
    `  reason: ${redactSecretText(request.reason)}`
  ].join("\n");
}
