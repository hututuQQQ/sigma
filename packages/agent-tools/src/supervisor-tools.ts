import { randomUUID } from "node:crypto";
import type {
  BudgetLimits,
  JsonValue,
  PlanGraph,
  RuntimeControlPort,
  SupervisorPort,
  ToolDescriptor,
  ToolEffect,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

const DELEGATED_CHILD_EFFECTS: ToolEffect[] = [
  "filesystem.read", "filesystem.read.external", "filesystem.write", "process.spawn",
  "process.spawn.readonly", "process.handoff", "agent.spawn", "network", "validation", "destructive"
];

function input(request: ToolRequest): Record<string, JsonValue> {
  return request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)
    ? request.arguments : {};
}

function requiredText(value: Record<string, JsonValue>, key: string): string {
  if (typeof value[key] !== "string" || !value[key]) throw new Error(`Tool argument '${key}' must be a non-empty string.`);
  return value[key];
}

function writeScope(value: Record<string, JsonValue>, mode: "analyze" | "change"): string[] {
  if (mode === "analyze") return [];
  const raw = Array.isArray(value.writeScope)
    ? value.writeScope.filter((item): item is string => typeof item === "string") : [];
  const normalized = [...new Set(raw.map((item) => item.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "")))];
  if (normalized.length === 0 || normalized.some((item) => !item || item === "." || item === ".."
    || item.startsWith("../") || item.startsWith("/") || /^[A-Za-z]:\//u.test(item))) {
    throw new Error("Writer children require a non-empty, workspace-relative writeScope without parent traversal.");
  }
  return normalized;
}

function planNodeIds(value: Record<string, JsonValue>): string[] {
  const raw = value.planNodeIds;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("planNodeIds must be a non-empty array of plan node IDs.");
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length === 0 || ids.length !== raw.length) throw new Error("planNodeIds must be non-empty and unique.");
  return ids;
}

function budgetAllocation(value: Record<string, JsonValue>): Partial<BudgetLimits> | undefined {
  const raw = value.budget;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("budget must be an object.");
  const allowed = new Set(["inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children", "maxDepth"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("budget contains an unknown dimension.");
  if (Object.values(raw).some((amount) => !Number.isSafeInteger(amount) || Number(amount) < 0)) {
    throw new Error("Child budget values must be non-negative integers.");
  }
  return { ...(raw as Partial<BudgetLimits>) };
}

function delegatedEffects(value: Record<string, JsonValue>, mode: "analyze" | "change"): ToolEffect[] {
  if (mode === "analyze") return ["agent.spawn", "filesystem.read"];
  const effects: ToolEffect[] = [
    "agent.spawn", "filesystem.read", "filesystem.write", "process.spawn", "process.spawn.readonly", "validation"
  ];
  if (value.network === "full") effects.push("network");
  if (value.allowDestructive === true) effects.push("destructive");
  return effects;
}

async function delegationPlan(control: RuntimeControlPort, ids: string[]): Promise<PlanGraph> {
  const current = await control.readPlan();
  for (const id of ids) {
    const node = current.nodes.find((item) => item.id === id);
    if (!node) throw new Error(`Unknown plan node '${id}'.`);
    if (node.owner.kind !== "root") {
      throw Object.assign(new Error(
        `Plan node '${id}' is already delegated to child '${node.owner.childId}' and cannot be reassigned.`
      ), { code: "plan_node_already_delegated" });
    }
    if (node.status === "completed" || node.status === "cancelled") {
      throw new Error(`Plan node '${id}' cannot be delegated from status '${node.status}'.`);
    }
  }
  return current;
}

async function assignPlanNodes(
  control: RuntimeControlPort,
  previous: PlanGraph,
  childId: string,
  ids: string[]
): Promise<void> {
  const selected = new Set(ids);
  await control.updatePlan({
    expectedRevision: previous.revision,
    plan: {
      ...previous,
      revision: previous.revision + 1,
      ...(previous.activeNodeId && selected.has(previous.activeNodeId) ? { activeNodeId: undefined } : {}),
      nodes: previous.nodes.map((node) => selected.has(node.id)
        ? {
            ...node,
            owner: { kind: "child" as const, childId },
            status: "in_progress" as const,
            blockedReason: undefined
          }
        : node)
    }
  });
}

function descriptor(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: string[] = [],
  approval: ToolDescriptor["approval"] = "auto",
  possibleEffects: ToolEffect[] = ["agent.spawn", "open_world"],
  executionMode: ToolDescriptor["executionMode"] = "parallel",
  resourceKeys: string[] = []
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    possibleEffects,
    executionMode,
    resourceKeys,
    approval,
    idempotent: false,
    timeoutMs: 900_000
  };
}

function receipt(request: ToolRequest, startedAt: string, value: unknown, observedEffects: ToolEffect[] = ["agent.spawn"]): ToolReceipt {
  return {
    callId: request.callId,
    ok: true,
    output: JSON.stringify(value),
    observedEffects,
    artifacts: [],
    diagnostics: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

async function executeSpawn(
  request: ToolRequest,
  context: Parameters<RegisteredEffectTool["execute"]>[1],
  supervisor: SupervisorPort
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const value = input(request);
  const mode = context.runMode === "analyze" ? "analyze" : value.mode === "change" ? "change" : "analyze";
  const scope = writeScope(value, mode);
  const ids = planNodeIds(value);
  const control = context.runtimeControl;
  if (!control) throw new Error("Runtime control is required to reserve a child budget.");
  const childId = randomUUID();
  const previousPlan = await delegationPlan(control, ids);
  const allocation = await control.reserveChildBudget(childId, budgetAllocation(value));
  let assigned = false;
  try {
    await assignPlanNodes(control, previousPlan, childId, ids);
    assigned = true;
    const child = await supervisor.spawnDurable({
      childId,
      parentId: context.sessionId,
      instruction: requiredText(value, "instruction"),
      workspacePath: context.workspacePath,
      intent: mode === "change" ? "write" : "analyze",
      writeScope: scope,
      delegatedEffects: delegatedEffects(value, mode),
      detached: value.detached === true,
      metadata: {
        mode,
        planNodeIds: ids,
        profileId: typeof value.profileId === "string" ? value.profileId : null,
        budget: { ...allocation }
      }
    });
    return receipt(request, startedAt, child, delegatedEffects(value, mode));
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (assigned) await control.rollbackChildPlanAssignment(childId, ids, previousPlan)
      .catch((failure) => cleanupErrors.push(failure));
    await control.releaseChildBudget(childId).catch((failure) => cleanupErrors.push(failure));
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Child spawn rollback failed.", { cause: error });
    throw error;
  }
}

function spawnTool(supervisor: SupervisorPort): RegisteredEffectTool {
  const spawnDescriptor = descriptor("spawn_agent", "Spawn an independent child agent. Use analyze mode for research and change mode only for a disjoint write scope.", {
    instruction: { type: "string" },
    mode: { type: "string", enum: ["analyze", "change"] },
    writeScope: { type: "array", items: { type: "string" } },
    planNodeIds: { type: "array", items: { type: "string" } },
    profileId: { type: "string" },
    network: { type: "string", enum: ["none", "loopback", "full"] },
    allowDestructive: { type: "boolean" },
    budget: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
    detached: { type: "boolean" }
  }, ["instruction", "planNodeIds"], "prompt", DELEGATED_CHILD_EFFECTS);
  return {
    descriptor: {
      ...spawnDescriptor,
      availableModes: ["analyze", "change"],
      maximumEffects: DELEGATED_CHILD_EFFECTS,
      prepare(argumentsValue, context) {
        const value = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
          ? argumentsValue as Record<string, JsonValue> : {};
        const mode = context.runMode === "analyze" ? "analyze" : value.mode === "change" ? "change" : "analyze";
        const scope = writeScope(value, mode);
        const exactEffects = delegatedEffects(value, mode);
        return {
          exactEffects,
          readPaths: ["."],
          writePaths: scope,
          network: exactEffects.includes("network") ? "full" : "none",
          processMode: mode === "change" ? "background" : "none",
          checkpointScope: mode === "change" ? scope : [],
          idempotence: "non_replayable"
        };
      }
    },
    async execute(request, context) {
      return await executeSpawn(request, context, supervisor);
    }
  };
}

function followUpTool(supervisor: SupervisorPort): RegisteredEffectTool {
  return {
    descriptor: descriptor("message_agent", "Send a follow-up message to a running child agent's durable mailbox.", {
      childId: { type: "string" }, text: { type: "string" }
    }, ["childId", "text"]),
    async execute(request) {
      const startedAt = new Date().toISOString();
      const value = input(request);
      supervisor.followUp(requiredText(value, "childId"), requiredText(value, "text"));
      return receipt(request, startedAt, { delivered: true });
    }
  };
}

function joinTool(supervisor: SupervisorPort): RegisteredEffectTool {
  return {
    descriptor: descriptor("join_agent", "Wait for a child agent and return its typed outcome and report.", { childId: { type: "string" } }, ["childId"]),
    async execute(request) {
      const startedAt = new Date().toISOString();
      return receipt(request, startedAt, await supervisor.join(requiredText(input(request), "childId")));
    }
  };
}

function listTool(supervisor: SupervisorPort): RegisteredEffectTool {
  return {
    descriptor: descriptor("list_agents", "List child agents owned by this session.", {}),
    async execute(request, context) {
      return receipt(request, new Date().toISOString(), supervisor.list(context.sessionId));
    }
  };
}

function integrateTool(supervisor: SupervisorPort): RegisteredEffectTool {
  const integrateDescriptor = descriptor(
      "integrate_agent",
      "Safely integrate a completed writer child's retained worktree after checking the source HEAD and declared write scope.",
      { childId: { type: "string" } },
      ["childId"],
      "prompt",
      ["agent.spawn", "filesystem.write", "process.spawn"],
      "exclusive",
      ["workspace:write"]
    );
  return {
    descriptor: { ...integrateDescriptor, availableModes: ["change"] },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const integrated = await supervisor.integrate(requiredText(input(request), "childId"), context.signal);
      return receipt(request, startedAt, integrated, ["agent.spawn", "filesystem.write", "process.spawn"]);
    }
  };
}

export function registerSupervisorTools(registry: EffectToolRegistry, supervisor: SupervisorPort): EffectToolRegistry {
  for (const tool of [spawnTool(supervisor), followUpTool(supervisor), joinTool(supervisor), listTool(supervisor), integrateTool(supervisor)]) registry.register(tool);
  return registry;
}
