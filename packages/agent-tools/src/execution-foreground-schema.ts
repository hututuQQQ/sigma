import type { JsonValue, ToolDescriptor } from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  availableShells,
  executableCapabilitySchema,
  executionToolSchema
} from "./execution-tool-values.js";

type ForegroundKind = "exec" | "shell" | "validate";

function writeContractProperties(): Record<string, JsonValue> {
  return {
    access: {
      type: "string", enum: ["readonly", "write"],
      description: "Explicit process filesystem access. Defaults to readonly; expectedChanges safely infers write access within the workspace."
    },
    writeRoots: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Existing sandbox ACL root directories. When omitted with expectedChanges, the nearest existing workspace directories are inferred."
    },
    expectedChanges: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Exact files or narrow paths approved to change. New parent directories needed to create an approved path are implicit; other changes are rolled back."
    },
    writePaths: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: "Deprecated compatibility alias that supplies both sandbox/checkpoint roots and approved changes."
    }
  };
}

function invocationProperties(
  kind: ForegroundKind,
  options: ExecutionToolOptions
): Record<string, JsonValue> {
  const validation = kind === "validate";
  const shells = availableShells(options);
  const shell: Record<string, JsonValue> = shells.length > 0
    ? { shell: { type: "string", enum: shells }, command: { type: "string" } }
    : {};
  if (kind === "shell") return shell;
  return {
    executable: executableCapabilitySchema(options),
    args: { type: "array", items: { type: "string" } },
    skill: { type: "string", pattern: "^(home|workspace):" },
    skillScript: { type: "string" },
    ...(validation ? shell : {})
  };
}

function validationSchema(
  schema: ToolDescriptor,
  shellAvailable: boolean
): ToolDescriptor["inputSchema"] {
  return {
    ...(schema.inputSchema as Record<string, JsonValue>),
    oneOf: [
      {
        required: ["executable"],
        not: { anyOf: [{ required: ["shell"] }, { required: ["command"] }] }
      },
      ...(shellAvailable ? [{
        required: ["shell", "command"],
        not: { required: ["executable"] }
      }] : [])
    ]
  };
}

export function foregroundExecutionSchema(
  kind: ForegroundKind,
  options: ExecutionToolOptions,
  network: JsonValue
): { schema: ToolDescriptor; validation: boolean } {
  const validation = kind === "validate";
  const properties = {
    ...invocationProperties(kind, options),
    cwd: { type: "string" },
    network,
    env: { type: "object", additionalProperties: { type: "string" } },
    timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
    ...writeContractProperties()
  };
  const required = validation ? [] : kind === "shell" ? ["shell", "command"] : ["executable"];
  const effects: ToolDescriptor["possibleEffects"] = validation
    ? ["process.spawn", "process.spawn.readonly", "filesystem.read", "filesystem.read.external", "filesystem.write", "validation", "network", "open_world"]
    : ["process.spawn", "process.spawn.readonly", "filesystem.read", "filesystem.read.external", "filesystem.write", "network", "open_world"];
  const description = validation
    ? "Run a sandboxed validation using exactly one form: {executable,args} or {shell,command}. The runtime classifies semantic assurance from the command adapter and its exact subjects; working-directory and filesystem permissions never imply validation coverage."
    : `Run a sandboxed ${kind} command. With skill and skillScript, the frozen script is prepended to interpreter args.`;
  const base = executionToolSchema(kind, description, properties, required, effects);
  const schema = validation
    ? { ...base, inputSchema: validationSchema(base, availableShells(options).length > 0) }
    : base;
  return { schema, validation };
}
