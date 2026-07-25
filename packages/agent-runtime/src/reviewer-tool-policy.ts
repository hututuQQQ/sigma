import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect
} from "agent-protocol";
import { jsonObject } from "./reviewer-tool-shared.js";

const FORBIDDEN_EFFECTS = new Set<ToolEffect>([
  "repository.write",
  "process.handoff",
  "agent.spawn",
  "outcome.propose",
  "outcome.report_blocked",
  "outcome.request_input",
  "checkpoint.restore",
  "destructive"
]);

const CATALOG_FORBIDDEN_EFFECTS = new Set<ToolEffect>([
  "repository.write",
  "process.handoff",
  "agent.spawn",
  "outcome.propose",
  "outcome.report_blocked",
  "outcome.request_input",
  "checkpoint.restore",
  "destructive",
  "runtime.control"
]);

export const SPECIAL_ARTIFACT_TOOL: ModelToolDefinition = {
  name: "read_artifact",
  description:
    "Read a session-scoped byte range from an artifact referenced by the current verification material.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      artifactId: { type: "string" },
      offsetBytes: { type: "integer", minimum: 0 },
      maxBytes: { type: "integer", minimum: 1, maximum: 65_536 }
    },
    required: ["artifactId"]
  }
};

export const SPECIAL_CHANGE_SET_TOOL: ModelToolDefinition = {
  name: "read_change_set",
  description:
    "Page through the durable baseline-to-current change material supplied to this verification session.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      offsetBytes: { type: "integer", minimum: 0 },
      maxBytes: { type: "integer", minimum: 1, maximum: 65_536 }
    }
  }
};

export function modelDefinition(descriptor: ToolDescriptor): ModelToolDefinition {
  if (descriptor.name === "lsp") {
    const schema = structuredClone(descriptor.inputSchema) as Record<string, import("agent-protocol").JsonValue>;
    const properties = jsonObject(schema.properties as import("agent-protocol").JsonValue);
    const operation = jsonObject(properties.operation);
    properties.operation = {
      ...operation,
      enum: Array.isArray(operation.enum)
        ? operation.enum.filter((item) => item !== "rename")
        : ["symbols", "definition", "references", "hover", "diagnostics"]
    };
    delete properties.newName;
    schema.properties = properties;
    return {
      name: descriptor.name,
      description: "Query a sandboxed language server without editing the parent workspace.",
      inputSchema: schema
    };
  }
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema
  };
}

export function catalogAllowed(descriptor: ToolDescriptor): boolean {
  // Descriptors advertise a conservative superset. Shell, validate, and LSP
  // can be admitted here because the frozen per-call plan remains authoritative.
  if (descriptor.possibleEffects.some((effect) =>
    CATALOG_FORBIDDEN_EFFECTS.has(effect))) return false;
  if ([
    "environment_shell",
    "environment_process_spawn",
    "process_spawn",
    "process_poll",
    "process_write",
    "process_terminate"
  ]
    .includes(descriptor.name)) return false;
  const directWrite = descriptor.possibleEffects.includes("filesystem.write")
    && !descriptor.possibleEffects.includes("process.spawn")
    && !descriptor.possibleEffects.includes("process.spawn.readonly");
  return !directWrite;
}

export function assertReviewerPlan(
  descriptor: ToolDescriptor,
  plan: ToolCallPlan,
  overlay: boolean,
  allowExternalRead = false
): void {
  const forbidden = plan.exactEffects.filter((effect) => FORBIDDEN_EFFECTS.has(effect));
  if (forbidden.length > 0) {
    throw Object.assign(new Error(
      `Independent verification cannot authorize effects: ${forbidden.join(", ")}.`
    ), { code: "review_tool_effect_denied" });
  }
  if (plan.exactEffects.includes("filesystem.read.external") && !allowExternalRead) {
    throw Object.assign(new Error(
      "Independent verification cannot read outside the parent workspace."
    ), { code: "review_external_read_denied" });
  }
  if (plan.exactEffects.includes("runtime.control")) {
    throw Object.assign(new Error(
      "Independent verification cannot invoke general runtime-control tools."
    ), { code: "review_runtime_control_denied" });
  }
  if (plan.exactEffects.includes("open_world")) {
    throw Object.assign(new Error(
      "Independent verification cannot execute an open-world process request."
    ), { code: "review_open_world_denied" });
  }
  if (plan.processMode === "background"
    && !(descriptor.name === "lsp"
      && !plan.exactEffects.includes("filesystem.write"))) {
    throw Object.assign(new Error(
      "Independent verification cannot leave background processes running."
    ), { code: "review_background_denied" });
  }
  if (plan.exactEffects.includes("filesystem.write")
    && !descriptor.possibleEffects.includes("process.spawn")) {
    throw Object.assign(new Error(
      "Independent verification cannot invoke a direct workspace-writing tool."
    ), { code: "review_write_tool_denied" });
  }
  const requiresOverlay = plan.exactEffects.includes("filesystem.write")
    || plan.exactEffects.includes("process.spawn");
  if (requiresOverlay && !overlay) {
    throw Object.assign(new Error(
      "This verification requires disposable-overlay write access, but no overlay is available."
    ), { code: "review_overlay_unavailable" });
  }
}

export function needsOverlay(plan: ToolCallPlan): boolean {
  return plan.exactEffects.includes("filesystem.write")
    || plan.exactEffects.includes("process.spawn");
}

export function reviewerExecutionCall(
  call: ModelToolCall,
  descriptor: ToolDescriptor
): ModelToolCall {
  if (!["exec", "shell", "validate"].includes(descriptor.name)) return call;
  const input = jsonObject(call.arguments);
  if (input.access !== undefined) return call;
  return {
    ...call,
    arguments: {
      ...input,
      access: "write",
      writeRoots: ["."],
      expectedChanges: ["."]
    }
  };
}

export function specialPlan(): ToolCallPlan {
  return {
    exactEffects: ["filesystem.read"],
    readPaths: [],
    writePaths: [],
    network: "none",
    processMode: "none",
    checkpointScope: [],
    idempotence: "read_only"
  };
}
