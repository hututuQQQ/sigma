const MIN_HOSTED_TOOL_SEARCH_FUNCTIONS = 12;
const MAX_NAMESPACE_FUNCTIONS = 9;

interface ResponsesTool {
  type?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

interface NamespaceDefinition {
  name: string;
  description: string;
}

const NAMESPACES = {
  workspace_read: {
    name: "workspace_read",
    description: "Read-only workspace, repository, code-intelligence, document, and image inspection."
  },
  workspace_write: {
    name: "workspace_write",
    description: "Structured workspace file creation, editing, patching, and deletion."
  },
  execution: {
    name: "execution",
    description: "Foreground and background command execution, validation, and process lifecycle control."
  },
  version_control: {
    name: "version_control",
    description: "Git status, diff inspection, and journaled repository transactions."
  },
  planning_state: {
    name: "planning_state",
    description: "Plans, budgets, artifacts, skills, checkpoints, and durable workspace state."
  },
  recovery: {
    name: "recovery",
    description: "Restore or confirm restoration of changes made during the current run."
  },
  delegation_review: {
    name: "delegation_review",
    description: "Subagent delegation, coordination, integration, and independent review."
  },
  user_coordination: {
    name: "user_coordination",
    description: "Request user input or report a concrete blocker."
  },
  connected_services: {
    name: "connected_services",
    description: "Network, web, MCP, and connected external-service capabilities."
  },
  additional_capabilities: {
    name: "additional_capabilities",
    description: "Additional runtime capabilities not covered by the primary namespaces."
  }
} as const satisfies Record<string, NamespaceDefinition>;

const WORKSPACE_READ = new Set([
  "read", "list", "grep", "batch_read", "repository_inspect", "repository_stats",
  "lsp", "inspect_document", "inspect_image"
]);
const WORKSPACE_WRITE = new Set([
  "write", "edit", "write_chunk", "delete_file", "apply_patch"
]);
const EXECUTION = new Set([
  "shell", "exec", "validate", "process_spawn", "process_poll", "process_write",
  "process_terminate", "process_handoff", "environment_prepare"
]);
const VERSION_CONTROL = new Set(["git_status", "git_diff", "git_transaction"]);
const PLANNING_STATE = new Set([
  "update_plan", "read_plan", "read_budget", "read_workspace_frontier",
  "read_artifact", "load_skill", "list_checkpoints"
]);
const RECOVERY = new Set(["restore_run_changes", "confirm_run_restored"]);
const DELEGATION_REVIEW = new Set([
  "spawn_agent", "message_agent", "join_agent", "list_agents", "integrate_agent",
  "request_review"
]);
const USER_COORDINATION = new Set(["request_user_input", "report_blocked"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function functionName(tool: unknown): string | undefined {
  const candidate = record(tool) as ResponsesTool | undefined;
  return candidate?.type === "function" && typeof candidate.name === "string"
    ? candidate.name : undefined;
}

function namespaceFor(name: string): NamespaceDefinition {
  if (WORKSPACE_READ.has(name)) return NAMESPACES.workspace_read;
  if (WORKSPACE_WRITE.has(name)) return NAMESPACES.workspace_write;
  if (EXECUTION.has(name)) return NAMESPACES.execution;
  if (VERSION_CONTROL.has(name)) return NAMESPACES.version_control;
  if (PLANNING_STATE.has(name)) return NAMESPACES.planning_state;
  if (RECOVERY.has(name)) return NAMESPACES.recovery;
  if (DELEGATION_REVIEW.has(name)) return NAMESPACES.delegation_review;
  if (USER_COORDINATION.has(name)) return NAMESPACES.user_coordination;
  if (name === "web_run" || name.startsWith("mcp_")) {
    return NAMESPACES.connected_services;
  }
  return NAMESPACES.additional_capabilities;
}

function chunkedNamespaces(functions: readonly ResponsesTool[]): Array<Record<string, unknown>> {
  const grouped = new Map<string, { definition: NamespaceDefinition; tools: ResponsesTool[] }>();
  for (const tool of functions) {
    const name = functionName(tool);
    if (!name) continue;
    const definition = namespaceFor(name);
    const group = grouped.get(definition.name) ?? { definition, tools: [] };
    group.tools.push(tool);
    grouped.set(definition.name, group);
  }

  const result: Array<Record<string, unknown>> = [];
  for (const { definition, tools } of [...grouped.values()]
    .sort((left, right) => left.definition.name.localeCompare(right.definition.name))) {
    const ordered = [...tools].sort((left, right) =>
      String(left.name).localeCompare(String(right.name)));
    for (let offset = 0; offset < ordered.length; offset += MAX_NAMESPACE_FUNCTIONS) {
      const chunk = ordered.slice(offset, offset + MAX_NAMESPACE_FUNCTIONS);
      const part = Math.floor(offset / MAX_NAMESPACE_FUNCTIONS) + 1;
      const split = ordered.length > MAX_NAMESPACE_FUNCTIONS;
      result.push({
        type: "namespace",
        name: split ? `${definition.name}_${part}` : definition.name,
        description: split
          ? `${definition.description} Capability group ${part}.`
          : definition.description,
        tools: chunk.map((tool) => ({ ...tool, defer_loading: true }))
      });
    }
  }
  return result;
}

function replayWithNamespaces(
  input: unknown,
  namespaceByFunction: ReadonlyMap<string, string>
): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    const call = record(item);
    if (call?.type !== "function_call" || typeof call.name !== "string") return item;
    const namespace = namespaceByFunction.get(call.name);
    return namespace ? { ...call, namespace } : item;
  });
}

/**
 * Convert a large Codex Responses function surface into provider-hosted,
 * deferred namespaces. The full trusted inventory remains in the request for
 * server-side search, while the model initially sees only namespace summaries.
 */
export function hostedToolSearchPayload(payload: unknown, enabled: boolean): unknown {
  if (!enabled) return payload;
  const body = record(payload);
  if (!body || body.tool_choice === "none" || !Array.isArray(body.tools)) return payload;
  if (body.tools.some((tool) => {
    const candidate = record(tool);
    return candidate?.type === "namespace" || candidate?.type === "tool_search";
  })) return payload;

  const functions = body.tools
    .filter((tool): tool is ResponsesTool => functionName(tool) !== undefined);
  if (functions.length < MIN_HOSTED_TOOL_SEARCH_FUNCTIONS) return payload;

  const namespaces = chunkedNamespaces(functions);
  const namespaceByFunction = new Map<string, string>();
  for (const namespace of namespaces) {
    if (typeof namespace.name !== "string" || !Array.isArray(namespace.tools)) continue;
    for (const tool of namespace.tools) {
      const name = functionName(tool);
      if (name) namespaceByFunction.set(name, namespace.name);
    }
  }
  const immediate = body.tools.filter((tool) => functionName(tool) === undefined);
  return {
    ...body,
    input: replayWithNamespaces(body.input, namespaceByFunction),
    tools: [...immediate, ...namespaces, { type: "tool_search" }]
  };
}

export const hostedToolSearchPolicy = Object.freeze({
  minimumFunctions: MIN_HOSTED_TOOL_SEARCH_FUNCTIONS,
  maximumFunctionsPerNamespace: MAX_NAMESPACE_FUNCTIONS
});
