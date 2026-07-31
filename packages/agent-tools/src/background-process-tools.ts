import path from "node:path";
import type {
  ProcessHandle
} from "agent-execution";
import type {
  JsonValue,
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { processReceipt } from "./execution-output-artifacts.js";
import { writeContractProperties } from "./execution-foreground-schema.js";
import {
  prepareExecutionCallPlan
} from "./execution-tool-planning.js";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  availableShells,
  availableNetworkModes,
  executableCapabilitySchema,
  executionArgs,
  executionText,
  executionToolSchema
} from "./execution-tool-values.js";
import {
  DEFAULT_PROCESS_POLL_YIELD_MS,
  pollProcessUntilYield,
  processYieldMs
} from "./process-wait.js";
import { simpleExecutionReceipt } from "./execution-tool-receipts.js";
import { processHandoffTool } from "./process-handoff-tool.js";
import type {
  PlannedToolExecutionContext,
  RegisteredEffectTool
} from "./registry.js";

export type BackgroundProcessExecutor = (
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext,
  allowEnclosingContainerDeliverable?: boolean
) => Promise<ToolReceipt>;

function networkProperty(options: ExecutionToolOptions): JsonValue {
  return {
    type: "string",
    enum: availableNetworkModes(options),
    description: `Per-call network policy; configured default is '${options.networkMode}'. none denies sockets, loopback is limited to local test services when supported, and full always requires fresh approval.`
  };
}

function handle(input: Record<string, JsonValue>): ProcessHandle {
  return {
    id: executionText(input, "handleId"),
    brokerInstanceId: executionText(input, "brokerInstanceId")
  };
}

function environmentProcessAvailable(options: ExecutionToolOptions): boolean {
  return options.background !== false
    && options.readScope === "host"
    && options.writeScope === "enclosing-container"
    && options.enclosingContainerRoot === true
    && Boolean(options.enclosingContainerAttestationDigest);
}

function environmentProcessArguments(
  value: JsonValue,
  workspacePath: string
): Record<string, JsonValue> {
  const { target: _target, ...input } = executionArgs(value);
  const root = path.parse(path.resolve(workspacePath)).root;
  return {
    ...input,
    access: "write",
    writeRoots: [root],
    expectedChanges: [root]
  };
}

function resolvedSpawnArguments(
  value: JsonValue,
  workspacePath: string,
  environmentAvailable: boolean
): { input: Record<string, JsonValue>; environment: boolean } {
  const input = executionArgs(value);
  if (input.target === "environment") {
    if (!environmentAvailable) {
      throw Object.assign(new Error(
        "The broker-attested disposable outer environment is unavailable."
      ), { code: "policy_denied" });
    }
    return {
      input: environmentProcessArguments(input, workspacePath),
      environment: true
    };
  }
  if (input.target !== undefined && input.target !== "workspace") {
    throw Object.assign(new Error(
      "Process target must be 'workspace' or 'environment'."
    ), { code: "tool_arguments_invalid" });
  }
  const { target: _target, ...workspaceInput } = input;
  return { input: workspaceInput, environment: false };
}

function spawnTargetProperties(
  environmentAvailable: boolean
): Record<string, JsonValue> {
  return environmentAvailable ? {
    target: {
      type: "string",
      enum: ["workspace", "environment"],
      description:
        "Execution boundary. Defaults to workspace. Use environment only for system-level changes in the broker-attested disposable outer environment. Processes, sockets, and temporary files created there are visible only to later calls that also use target=environment."
    }
  } : {};
}

function spawnTool(
  options: ExecutionToolOptions,
  executeBackground: BackgroundProcessExecutor
): RegisteredEffectTool {
  const environmentAvailable = environmentProcessAvailable(options);
  const enclosing = options.writeScope === "enclosing-container"
    && options.enclosingContainerRoot === true;
  const effects: ToolDescriptor["possibleEffects"] = [
    "process.spawn.readonly",
    ...(enclosing ? ["process.spawn" as const, "filesystem.write" as const] : []),
    "filesystem.read",
    "filesystem.read.external",
    "network",
    "open_world"
  ];
  return {
    descriptor: {
      ...executionToolSchema(
        "process_spawn",
        environmentAvailable
          ? "Start a sandboxed background process and return an in-session handle. Set target=environment only for a service that needs system-level changes in the broker-attested disposable outer environment; use that same target for later inspection or control because workspace-target calls use a separate sandbox view."
          : "Start a sandboxed background process and return an in-session handle.",
        {
          executable: executableCapabilitySchema(options),
          args: { type: "array", items: { type: "string" } },
          ...spawnTargetProperties(environmentAvailable),
          cwd: { type: "string" },
          network: networkProperty(options),
          env: { type: "object", additionalProperties: { type: "string" } },
          ...(options.pty === false ? {} : { pty: { type: "boolean" } }),
          ...(options.handoff === true ? {
            lifecycle: {
              type: "string",
              enum: ["session", "deliverable"],
              description: "Use deliverable only for a service that must survive successful task completion; verify it through a separate interface probe, then call process_handoff."
            }
          } : {}),
          readRoots: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
            description: "Additional existing directories to read; external paths require host read scope."
          },
          ...writeContractProperties(options)
        },
        ["executable"],
        effects
      ),
      ...(enclosing
        ? { brokerMutationAuthority: "disposable_enclosing_container" as const }
        : {}),
      prepare(value, context) {
        const resolved = resolvedSpawnArguments(
          value, context.workspacePath, environmentAvailable
        );
        return prepareExecutionCallPlan(
          resolved.input,
          context,
          options,
          false,
          true,
          resolved.environment
        );
      }
    },
    async execute(request, context) {
      const resolved = resolvedSpawnArguments(
        request.arguments, context.workspacePath, environmentAvailable
      );
      return await executeBackground(options, {
        ...request,
        arguments: resolved.input
      }, context, resolved.environment);
    }
  };
}

function processPollTool(
  options: ExecutionToolOptions,
  handleProperties: Record<string, JsonValue>
): RegisteredEffectTool {
  return {
    descriptor: executionToolSchema(
      "process_poll",
      "Wait briefly for incremental output or completion from an in-session background process. Returns immediately when output or terminal state is available.",
      {
        ...handleProperties,
        yieldMs: {
          type: "integer",
          minimum: 0,
          maximum: 30000,
          description:
            "Maximum wait for output or completion. Defaults to 5000 ms; set 0 for an immediate poll."
        }
      },
      ["handleId", "brokerInstanceId"],
      ["process.spawn.readonly"]
    ),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      const input = executionArgs(request.arguments);
      const result = await pollProcessUntilYield(
        options.broker,
        handle(input),
        processYieldMs(input, DEFAULT_PROCESS_POLL_YIELD_MS),
        context.signal,
        true
      );
      return await processReceipt(
        request,
        startedAt,
        result,
        ["process.spawn.readonly"],
        context,
        options.broker,
        "poll"
      );
    }
  };
}

function processWriteTool(
  options: ExecutionToolOptions,
  handleProperties: Record<string, JsonValue>
): RegisteredEffectTool {
  return {
    descriptor: executionToolSchema("process_write", "Write UTF-8 input to an in-session background process.", {
      ...handleProperties,
      data: { type: "string" }
    }, ["handleId", "brokerInstanceId", "data"], ["process.spawn.readonly"]),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      const input = executionArgs(request.arguments);
      await options.broker.write(
        handle(input),
        executionText(input, "data"),
        { signal: context.signal }
      );
      return simpleExecutionReceipt(
        request,
        startedAt,
        { written: true },
        ["process.spawn.readonly"]
      );
    }
  };
}

function processTerminateTool(
  options: ExecutionToolOptions,
  handleProperties: Record<string, JsonValue>
): RegisteredEffectTool {
  return {
    descriptor: executionToolSchema(
      "process_terminate",
      "Terminate an in-session background process tree.",
      handleProperties,
      ["handleId", "brokerInstanceId"],
      ["process.spawn.readonly"]
    ),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await options.broker.terminate(
        handle(executionArgs(request.arguments)),
        { signal: context.signal }
      );
      return await processReceipt(
        request,
        startedAt,
        result,
        ["process.spawn.readonly"],
        context,
        options.broker,
        "terminate"
      );
    }
  };
}

function processControlTools(
  options: ExecutionToolOptions,
  handleProperties: Record<string, JsonValue>
): RegisteredEffectTool[] {
  return [
    processPollTool(options, handleProperties),
    ...(options.stdin === false
      ? [] : [processWriteTool(options, handleProperties)]),
    processTerminateTool(options, handleProperties),
    ...(options.handoff === true
    ? [processHandoffTool(options, handleProperties)]
    : [])
  ];
}

export function backgroundProcessTools(
  options: ExecutionToolOptions,
  executeBackground: BackgroundProcessExecutor
): RegisteredEffectTool[] {
  const handleProperties = {
    handleId: { type: "string" },
    brokerInstanceId: { type: "string" }
  };
  return [
    ...(availableShells(options).length === 0
      ? [spawnTool(options, executeBackground)]
      : []),
    ...processControlTools(options, handleProperties),
  ];
}
