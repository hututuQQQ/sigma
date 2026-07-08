import path from "node:path";
import type { ExecIntentSummary, ExecPolicyConfig, PermissionRequest, ToolExecutionContext, ToolResult, ToolRisk } from "./types.js";

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

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function commandStartsWith(command: string, prefix: string): boolean {
  const normalized = normalizeCommand(command).toLowerCase();
  const normalizedPrefix = normalizeCommand(prefix).toLowerCase();
  return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix} `);
}

function ruleLabel(match: string | string[]): string {
  return Array.isArray(match) ? match.join(" ") : match;
}

type ExecPolicyRuleEntry = NonNullable<ExecPolicyConfig["rules"]>[number];

function matchRule(command: string, rules: ExecPolicyConfig["rules"] = []): ExecPolicyRuleEntry | undefined {
  for (const rule of rules) {
    const candidates = Array.isArray(rule.match) ? rule.match : [rule.match];
    if (candidates.some((candidate) => commandStartsWith(command, candidate))) {
      return rule;
    }
  }
  return undefined;
}

export function classifyShellCommand(command: string): Omit<ExecIntentSummary, "action" | "reason" | "matchedRule"> {
  const normalized = normalizeCommand(command);
  const lower = normalized.toLowerCase();
  const mutatesWorkspace = [
    /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|exec|run)\b/,
    /\b(git)\s+(add|commit|push|checkout|switch|reset|clean|merge|rebase|apply|restore)\b/,
    />\s*[^&]|\btee\b|\bsed\s+-i\b/
  ].some((pattern) => pattern.test(lower));
  const changesGitState = /\bgit\s+(add|commit|push|checkout|switch|reset|clean|merge|rebase|apply|restore)\b/.test(lower);
  const usesNetwork = /\b(curl|wget|ssh|scp|rsync|npm|pnpm|yarn|bun|pip|uv|poetry|cargo|go)\s+/.test(lower) &&
    !/\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|build|typecheck))\b/.test(lower);
  const executesCode = /\b(node|python|python3|py|tsx|ts-node|bun|deno|ruby|perl|php|go|cargo|npm|pnpm|yarn)\b/.test(lower);
  const risk: ToolRisk = usesNetwork ? "network" : (mutatesWorkspace || executesCode ? "execute" : "read");
  return {
    command,
    risk,
    mutatesWorkspace,
    usesNetwork,
    changesGitState,
    executesCode
  };
}

function defaultActionForCommand(policy: ExecPolicyConfig | undefined, intent: Omit<ExecIntentSummary, "action" | "reason" | "matchedRule">): ExecIntentSummary["action"] {
  if (policy?.defaultAction) return policy.defaultAction;
  if (policy?.allowReadOnlyCommands !== false && intent.risk === "read") return "allow";
  return intent.mutatesWorkspace || intent.usesNetwork || intent.executesCode ? "prompt" : "allow";
}

function defaultReason(intent: Omit<ExecIntentSummary, "action" | "reason" | "matchedRule">, action: ExecIntentSummary["action"]): string {
  if (action === "deny") return "Command was denied by execution policy.";
  if (intent.usesNetwork) return "Command appears to use network access.";
  if (intent.changesGitState) return "Command appears to change git state.";
  if (intent.mutatesWorkspace) return "Command appears to modify workspace state.";
  if (intent.executesCode) return "Command executes code and requires approval in ask mode.";
  return "Command is classified as read-only.";
}

export function evaluateExecPolicy(command: string, policy?: ExecPolicyConfig): ExecIntentSummary {
  const intent = classifyShellCommand(command);
  const rule = matchRule(command, policy?.rules);
  const action = rule?.action ?? defaultActionForCommand(policy, intent);
  return {
    ...intent,
    action,
    ...(rule ? { matchedRule: ruleLabel(rule.match) } : {}),
    reason: rule?.reason ?? defaultReason(intent, action)
  };
}

export function isProbablyMutatingCommand(command: string): boolean {
  return classifyShellCommand(command).mutatesWorkspace;
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
