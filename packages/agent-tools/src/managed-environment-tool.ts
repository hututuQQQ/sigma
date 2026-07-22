import type { JsonValue } from "agent-protocol";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import type { RegisteredEffectTool } from "./registry.js";

function packages(input: Record<string, JsonValue>): string[] {
  const value = input.packages;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("environment_prepare packages must be an array of package names.");
  }
  return value as string[];
}

export function environmentPrepareTool(
  options: ExecutionToolOptions
): RegisteredEffectTool | undefined {
  if (!options.broker.prepareManagedEnvironment
    || options.executionBackend !== "oci"
    || options.managedEnvironment !== true
    || options.networkMode !== "full") return undefined;
  return {
    descriptor: descriptor({
      name: "environment_prepare",
      description: "Prepare one missing executable in the authenticated disposable managed environment. The broker verifies absence, uses one trusted system package manager with its default signature policy, and permits one package set for that executable.",
      properties: {
        requestedExecutable: {
          type: "string",
          description: "Exact missing executable alias or absolute target path."
        },
        packages: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9+._-]{0,127}$" }
        }
      },
      required: ["requestedExecutable", "packages"],
      possibleEffects: ["process.spawn", "network", "open_world"],
      maximumEffects: ["process.spawn", "network", "open_world"],
      executionMode: "exclusive",
      resourceKeys: ["managed-environment"],
      approval: "auto",
      idempotent: false,
      timeoutMs: 600_000,
      idleTimeoutMs: 120_000,
      prepare() {
        return {
          exactEffects: ["process.spawn", "network", "open_world"],
          readPaths: [],
          writePaths: [],
          network: "full",
          processMode: "pipe",
          checkpointScope: [],
          idempotence: "non_replayable"
        };
      }
    }),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = args(request.arguments);
      const result = await options.broker.prepareManagedEnvironment!({
        protocolVersion: 1,
        sessionId: context.sessionId,
        requestedExecutable: stringArg(input, "requestedExecutable"),
        packages: packages(input)
      }, { signal: context.signal, timeoutMs: 600_000 });
      return receipt(request, startedAt, {
        output: JSON.stringify(result),
        observedEffects: ["process.spawn", "network", "open_world"],
        diagnostics: [
          "managed_environment_prepared",
          `package_manager=${result.packageManager}`,
          `attempt_digest=${result.attemptDigest}`,
          `runtime_closure_digest=${result.runtimeClosure.digest}`,
          `signature_policy=${result.signaturePolicy}`
        ]
      });
    }
  };
}
