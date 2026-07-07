import { redactSecretText, type PermissionRequest } from "agent-core";

export function ApprovalPrompt(request: PermissionRequest | null): string {
  if (!request) return "";
  return [
    "Approval",
    `  tool: ${request.toolName}`,
    `  risk: ${request.risk}`,
    `  reason: ${redactSecretText(request.reason)}`,
    "  y=allow n=deny a=always allow"
  ].join("\n");
}
