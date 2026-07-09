import type { JsonValue, SupervisorPort, ToolDescriptor, ToolEffect, ToolReceipt, ToolRequest } from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

const DELEGATED_CHILD_EFFECTS: ToolEffect[] = [
  "filesystem.read", "filesystem.write", "process.spawn", "process.spawn.readonly", "agent.spawn",
  "network", "validation", "destructive", "open_world"
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

function descriptor(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: string[] = [],
  approval: ToolDescriptor["approval"] = "auto",
  possibleEffects: ToolEffect[] = ["agent.spawn", "open_world"]
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    possibleEffects,
    executionMode: "parallel",
    resourceKeys: [],
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

function spawnTool(supervisor: SupervisorPort): RegisteredEffectTool {
  return {
    descriptor: descriptor("spawn_agent", "Spawn an independent child agent. Use analyze mode for research and change mode only for a disjoint write scope.", {
      instruction: { type: "string" },
      mode: { type: "string", enum: ["analyze", "change"] },
      writeScope: { type: "array", items: { type: "string" } },
      detached: { type: "boolean" }
    }, ["instruction"], "prompt", DELEGATED_CHILD_EFFECTS),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const value = input(request);
      const mode = context.runMode === "analyze" ? "analyze" : value.mode === "change" ? "change" : "analyze";
      const scope = writeScope(value, mode);
      const child = await supervisor.spawnDurable({
        parentId: context.sessionId,
        instruction: requiredText(value, "instruction"),
        workspacePath: context.workspacePath,
        intent: mode === "change" ? "write" : "analyze",
        writeScope: scope,
        delegatedEffects: DELEGATED_CHILD_EFFECTS,
        detached: value.detached === true,
        metadata: { mode }
      });
      return receipt(request, startedAt, child);
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
  return {
    descriptor: descriptor(
      "integrate_agent",
      "Safely integrate a completed writer child's retained worktree after checking the source HEAD and declared write scope.",
      { childId: { type: "string" } },
      ["childId"],
      "prompt",
      ["agent.spawn", "filesystem.write", "process.spawn"]
    ),
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
