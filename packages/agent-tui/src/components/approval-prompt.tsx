import { redactSecretText, type PermissionRequest } from "agent-core";
import { summarizeToolArguments } from "./formatting.js";

export function ApprovalPrompt(request: PermissionRequest | null): string {
  if (!request) return "";
  const summary = summarizeToolArguments(request.toolName, request.arguments);
  return [
    "Approval required",
    "  The run is paused. Press one key to continue; Enter is not required.",
    "  keys: y = allow once    n = deny    a = always allow this kind of request",
    "",
    `  tool: ${request.toolName}`,
    `  risk: ${request.risk}`,
    `  workspace: ${request.workspacePath}`,
    `  reason: ${redactSecretText(request.reason)}`,
    `  arguments: ${summary || redactSecretText(JSON.stringify(request.arguments))}`
  ].join("\n");
}
