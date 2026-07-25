import type { JsonValue, ToolDescriptor } from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  assertAvailableExecutable,
  assertAvailableShell,
  availableShells,
  executableCapabilitySchema,
  executionToolSchema
} from "./execution-tool-values.js";
import { environmentShellAvailable } from "./environment-shell-tool.js";

type ForegroundKind = "exec" | "shell" | "validate";

function hasDirectOnlyFields(input: Record<string, JsonValue>): boolean {
  return input.args !== undefined
    || input.skill !== undefined
    || input.skillScript !== undefined;
}

function invalidArguments(message: string): never {
  throw Object.assign(new Error(message), { code: "tool_arguments_invalid" });
}

function assertShellInvocationShape(
  input: Record<string, JsonValue>,
  hasExecutable: boolean,
  hasCommand: boolean
): void {
  if (hasExecutable === hasCommand || (hasCommand && hasDirectOnlyFields(input))
    || (hasExecutable && (input.shell !== undefined || input.target !== undefined))) {
    invalidArguments(
      "shell requires exactly one invocation form: {command,shell?} or {executable,args?,skill?,skillScript?}."
    );
  }
}

function assertValidationInvocationShape(
  input: Record<string, JsonValue>,
  hasExecutable: boolean,
  hasCommand: boolean
): void {
  const hasShell = input.shell !== undefined;
  const shellForm = hasShell || hasCommand;
  if (hasExecutable === shellForm
    || (shellForm && (!hasShell || !hasCommand || hasDirectOnlyFields(input)))) {
    invalidArguments(
      "validate requires exactly one invocation form: {executable,args?,skill?,skillScript?} or {shell,command}."
    );
  }
}

export function assertForegroundInvocation(
  kind: ForegroundKind,
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions
): boolean {
  const hasExecutable = input.executable !== undefined;
  const hasCommand = input.command !== undefined;
  if (kind === "shell") assertShellInvocationShape(input, hasExecutable, hasCommand);
  if (kind === "validate") assertValidationInvocationShape(input, hasExecutable, hasCommand);
  const shellCommand = kind !== "exec" && hasCommand;
  if (shellCommand) assertAvailableShell(input, options);
  else assertAvailableExecutable(input, options);
  return shellCommand;
}

export function writeContractProperties(
  options: ExecutionToolOptions
): Record<string, JsonValue> {
  const enclosing = options.writeScope === "enclosing-container"
    && options.enclosingContainerRoot === true;
  return {
    access: {
      type: "string", enum: ["readonly", "write"],
      description: enclosing
        ? "Explicit process filesystem access. Defaults to readonly. Workspace and enclosing-container writes must be made in separate calls."
        : "Explicit process filesystem access. Defaults to readonly; expectedChanges safely infers write access within the workspace."
    },
    writeRoots: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: enclosing
        ? "Existing sandbox ACL root directories. Relative paths are workspace-scoped; canonical absolute paths outside the workspace target the attested disposable enclosing container."
        : "Existing sandbox ACL root directories. When omitted with expectedChanges, the nearest existing workspace directories are inferred."
    },
    expectedChanges: {
      type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true,
      description: enclosing
        ? "Exact files or narrow paths approved to change. Use canonical absolute paths for enclosing-container changes. External changes persist only for the disposable task container and are independently reviewed."
        : "Exact files or narrow paths approved to change. New parent directories needed to create an approved path are implicit; other changes are rolled back."
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
  const executable = {
    executable: executableCapabilitySchema(options),
    args: { type: "array", items: { type: "string" } },
    skill: { type: "string", pattern: "^(home|workspace):" },
    skillScript: { type: "string" }
  };
  if (kind === "shell") {
    return {
      ...shell,
      ...executable,
      ...(environmentShellAvailable(options) ? {
        target: {
          type: "string",
          enum: ["workspace", "environment"],
          description:
            "Execution boundary. Defaults to workspace. Use environment only for system-level changes in the broker-attested disposable outer environment."
        }
      } : {})
    };
  }
  return {
    ...executable,
    ...(validation ? shell : {})
  };
}

function invocationSchema(
  schema: ToolDescriptor,
  kind: ForegroundKind,
  shellAvailable: boolean
): ToolDescriptor["inputSchema"] {
  const alternatives: JsonValue[] = kind === "shell"
      ? [
        {
          required: ["command"],
          not: {
            anyOf: [
              { required: ["executable"] },
              { required: ["args"] },
              { required: ["skill"] },
              { required: ["skillScript"] }
            ]
          }
        },
        {
          required: ["executable"],
          not: {
            anyOf: [
              { required: ["command"] },
              { required: ["shell"] },
              { required: ["target"] }
            ]
          }
        }
      ]
    : [
        {
          required: ["executable"],
          not: { anyOf: [{ required: ["shell"] }, { required: ["command"] }] }
        },
        ...(shellAvailable ? [{
          required: ["shell", "command"],
          not: {
            anyOf: [
              { required: ["executable"] },
              { required: ["args"] },
              { required: ["skill"] },
              { required: ["skillScript"] }
            ]
          }
        }] : [])
      ];
  return {
    ...(schema.inputSchema as Record<string, JsonValue>),
    oneOf: alternatives
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
    readRoots: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      description: "Additional existing directories to read. Absolute paths outside the workspace require host read scope and fresh approval."
    },
    network,
    env: { type: "object", additionalProperties: { type: "string" } },
    timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
    ...(validation ? {
      purpose: {
        type: "string",
        description: "Optional model-declared reason for this check. It is recorded as intent, not treated as proof."
      },
      subjects: {
        type: "array",
        items: { type: "string" },
        maxItems: 128,
        description: "Optional paths or logical subjects the model intends to check."
      },
      criterionIds: {
        type: "array",
        items: { type: "string" },
        maxItems: 64,
        description: "Optional acceptance-criterion identifiers this check is intended to inform."
      }
    } : {}),
    ...writeContractProperties(options)
  };
  const required = validation || kind === "shell" ? [] : ["executable"];
  const effects: ToolDescriptor["possibleEffects"] = validation
    ? ["process.spawn", "process.spawn.readonly", "filesystem.read", "filesystem.read.external", "filesystem.write", "validation", "network", "open_world"]
    : ["process.spawn", "process.spawn.readonly", "filesystem.read", "filesystem.read.external", "filesystem.write", "network", "open_world"];
  const description = validation
    ? "Run a sandboxed validation using exactly one form: {executable,args} or {shell,command}. The runtime freezes the declared intent and objective command result; an independent reviewer decides semantic coverage."
    : kind === "shell"
      ? [
          "Run one sandboxed foreground command using exactly one form: {command,shell?} or {executable,args?,skill?,skillScript?}. The runtime chooses a deterministic broker-verified shell when shell is omitted.",
          ...(environmentShellAvailable(options)
            ? ["Set target=environment only for system-level changes in the broker-attested disposable outer environment."]
            : [])
        ].join(" ")
      : `Run a sandboxed ${kind} command. With skill and skillScript, the frozen script is prepended to interpreter args.`;
  const base = executionToolSchema(kind, description, properties, required, effects);
  const schema = validation || kind === "shell"
    ? { ...base, inputSchema: invocationSchema(base, kind, availableShells(options).length > 0) }
    : base;
  return { schema, validation };
}
