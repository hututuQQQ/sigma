import path from "node:path";
import type { PermissionRequest, ToolExecutionContext, ToolResult, ToolRisk } from "./types.js";

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

export function resolveWorkspacePath(workspacePath: string, requestedPath: string): string {
  const workspace = path.resolve(workspacePath);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspace, requestedPath);

  if (!isPathInside(workspace, candidate)) {
    throw new Error(`Path is outside the workspace: ${requestedPath}`);
  }

  return candidate;
}

export function isProbablyMutatingCommand(command: string): boolean {
  const patterns = [
    /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|exec|run)\b/,
    /\b(git)\s+(add|commit|push|checkout|switch|reset|clean|merge|rebase|apply)\b/,
    /\b(python|python3|node|tsx|ts-node)\b/,
    />\s*[^&]|\btee\b|\bsed\s+-i\b/
  ];
  return patterns.some((pattern) => pattern.test(command));
}

export function permissionDeniedResult(toolName: string, risk: ToolRisk): ToolResult {
  return {
    ok: false,
    content: `Permission denied for ${toolName} (${risk}). Mutating or risky tools require yolo mode or explicit approval.`
  };
}

export async function requestToolPermission(
  context: ToolExecutionContext,
  request: Omit<PermissionRequest, "workspacePath">
): Promise<ToolResult | null> {
  if (request.risk === "read") return null;
  if (context.permissionMode === "yolo") return null;
  if (context.alwaysAllowTools.has(request.toolName)) return null;
  if (!context.permissionDecider) {
    return permissionDeniedResult(request.toolName, request.risk);
  }

  const decision = await context.permissionDecider.decide({
    ...request,
    workspacePath: context.workspacePath
  });
  if (decision === "allow") return null;
  if (decision === "always_allow") {
    context.alwaysAllowTools.add(request.toolName);
    return null;
  }
  return permissionDeniedResult(request.toolName, request.risk);
}

export function workspaceRelativePath(workspacePath: string, candidatePath: string): string {
  return path.relative(path.resolve(workspacePath), path.resolve(candidatePath)).split(path.sep).join("/");
}
