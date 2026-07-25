import path from "node:path";
import type { JsonValue, ToolReceipt, ToolRequest } from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  prepareExecutionCallPlan
} from "./execution-tool-planning.js";
import {
  assertAvailableShell,
  availableNetworkModes,
  availableShells,
  executionArgs,
  executionToolSchema
} from "./execution-tool-values.js";
import type {
  PlannedToolExecutionContext,
  RegisteredEffectTool
} from "./registry.js";

type ForegroundExecutor = (
  kind: "shell",
  options: ExecutionToolOptions,
  request: ToolRequest,
  context: PlannedToolExecutionContext
) => Promise<ToolReceipt>;

function networkProperty(options: ExecutionToolOptions): JsonValue {
  return {
    type: "string",
    enum: availableNetworkModes(options),
    description:
      `Per-call network policy; configured default is '${options.networkMode}'.`
  };
}

function enclosingContainerRoot(workspacePath: string): string {
  return path.parse(path.resolve(workspacePath)).root;
}

function environmentArguments(
  value: JsonValue,
  workspacePath: string
): Record<string, JsonValue> {
  const input = executionArgs(value);
  const root = enclosingContainerRoot(workspacePath);
  return {
    ...input,
    access: "write",
    writeRoots: [root],
    expectedChanges: [root]
  };
}

function available(options: ExecutionToolOptions): boolean {
  return options.foreground !== false
    && options.readScope === "host"
    && options.writeScope === "enclosing-container"
    && options.enclosingContainerRoot === true
    && Boolean(options.enclosingContainerAttestationDigest)
    && availableShells(options).length > 0;
}

export function environmentShellTools(
  options: ExecutionToolOptions,
  executeForeground: ForegroundExecutor
): RegisteredEffectTool[] {
  if (!available(options)) return [];
  const shells = availableShells(options);
  return [{
    descriptor: {
      ...executionToolSchema(
        "environment_shell",
        "Run a shell command that intentionally changes the broker-attested disposable outer environment, such as installing a dependency or configuring a service. The runtime grants the outer container boundary while keeping the workspace and Sigma runtime protected. Use ordinary shell for observation and workspace write/edit tools for deliverables.",
        {
          command: { type: "string" },
          shell: { type: "string", enum: shells },
          cwd: { type: "string" },
          network: networkProperty(options),
          env: {
            type: "object",
            additionalProperties: { type: "string" }
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 600_000
          }
        },
        ["command"],
        [
          "process.spawn",
          "filesystem.read",
          "filesystem.read.external",
          "filesystem.write",
          "network",
          "open_world"
        ],
        ["change"]
      ),
      brokerMutationAuthority: "disposable_enclosing_container",
      async prepare(value, context) {
        const input = environmentArguments(value, context.workspacePath);
        assertAvailableShell(input, options);
        return await prepareExecutionCallPlan(input, context, options);
      }
    },
    async execute(request, context) {
      return await executeForeground("shell", options, {
        ...request,
        arguments: environmentArguments(
          request.arguments,
          context.workspacePath
        )
      }, context);
    }
  }];
}
