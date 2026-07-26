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
const VALIDATION_INTENT_FIELDS = ["purpose", "subjects", "criterionIds"] as const;

export interface ForegroundInvocation {
  shellCommand: boolean;
  validation: boolean;
  background: boolean;
}

function hasDirectOnlyFields(input: Record<string, JsonValue>): boolean {
  return input.args !== undefined
    || input.skill !== undefined
    || input.skillScript !== undefined;
}

function invalidArguments(message: string): never {
  throw Object.assign(new Error(message), { code: "tool_arguments_invalid" });
}

function assertShellModeTypes(input: Record<string, JsonValue>): void {
  if (input.background !== undefined && typeof input.background !== "boolean") {
    invalidArguments("shell background must be a boolean.");
  }
  if (input.validation !== undefined && typeof input.validation !== "boolean") {
    invalidArguments("shell validation must be a boolean.");
  }
}

function hasShellValidationIntent(input: Record<string, JsonValue>): boolean {
  return VALIDATION_INTENT_FIELDS.some((field) => input[field] !== undefined);
}

function shellValidationRequested(input: Record<string, JsonValue>): boolean {
  return input.validation === true || hasShellValidationIntent(input);
}

function assertShellValidationMode(input: Record<string, JsonValue>): void {
  const validation = shellValidationRequested(input);
  if (input.validation === false && hasShellValidationIntent(input)) {
    invalidArguments(
      "shell validation=false conflicts with purpose, subjects, or criterionIds; omit validation or set it to true."
    );
  }
  if (input.background === true && validation) {
    invalidArguments("shell background execution cannot be recorded as a completed validation.");
  }
}

function assertShellBackgroundMode(
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions
): void {
  const background = input.background === true;
  const backgroundFields = ["yieldMs", "pty", "lifecycle"] as const;
  if (!background && backgroundFields.some((field) => input[field] !== undefined)) {
    invalidArguments("shell yieldMs, pty, and lifecycle require background=true.");
  }
  if (background && options.background === false) {
    invalidArguments("shell background execution is unavailable for this execution broker.");
  }
  if (background && input.timeoutMs !== undefined) {
    invalidArguments("shell timeoutMs is foreground-only; use yieldMs for background startup.");
  }
  if (input.lifecycle === "deliverable" && options.handoff !== true) {
    invalidArguments("Deliverable process handoff is unavailable for this execution broker.");
  }
}

function assertShellInvocationShape(
  input: Record<string, JsonValue>,
  hasExecutable: boolean,
  hasCommand: boolean,
  options: ExecutionToolOptions
): void {
  if (hasExecutable === hasCommand || (hasCommand && hasDirectOnlyFields(input))
    || (hasExecutable && input.shell !== undefined)) {
    invalidArguments(
      "shell requires exactly one invocation form: {command,shell?} or {executable,args?,skill?,skillScript?}."
    );
  }
  assertShellModeTypes(input);
  assertShellValidationMode(input);
  assertShellBackgroundMode(input, options);
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
): ForegroundInvocation {
  const hasExecutable = input.executable !== undefined;
  const hasCommand = input.command !== undefined;
  if (kind === "shell") {
    assertShellInvocationShape(input, hasExecutable, hasCommand, options);
  }
  if (kind === "validate") assertValidationInvocationShape(input, hasExecutable, hasCommand);
  const shellCommand = kind !== "exec" && hasCommand;
  if (shellCommand) assertAvailableShell(input, options);
  else assertAvailableExecutable(input, options);
  return {
    shellCommand,
    validation: kind === "validate" || (kind === "shell" && shellValidationRequested(input)),
    background: kind === "shell" && input.background === true
  };
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
              { required: ["shell"] }
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

function validationIntentProperties(): Record<string, JsonValue> {
  return {
    purpose: {
      type: "string",
      description:
        "Model-declared reason for a completed check. Providing this marks a foreground shell call as validation; the declaration is recorded as intent, not treated as proof."
    },
    subjects: {
      type: "array",
      items: { type: "string" },
      maxItems: 128,
      description:
        "Paths or logical subjects a completed check intends to cover. Providing this marks a foreground shell call as validation."
    },
    criterionIds: {
      type: "array",
      items: { type: "string" },
      maxItems: 64,
      description:
        "Acceptance-criterion identifiers a completed check is intended to inform. Providing this marks a foreground shell call as validation."
    }
  };
}

function unifiedExecutionProperties(
  options: ExecutionToolOptions
): Record<string, JsonValue> {
  return {
    validation: {
      type: "boolean",
      description:
        "Optional explicit marker for a completed foreground check. Setting purpose, subjects, or criterionIds also marks the call as validation, so no second switch is required."
    },
    ...validationIntentProperties(),
    ...(options.background === false ? {} : {
      background: {
        type: "boolean",
        description:
          "Set true only for a long-running service or interactive process. The runtime waits up to yieldMs before returning a live handle."
      },
      yieldMs: {
        type: "integer",
        minimum: 0,
        maximum: 30000,
        description:
          "For background execution, wait for early completion before yielding a live handle. Defaults to 10000 ms."
      },
      ...(options.pty === false ? {} : {
        pty: {
          type: "boolean",
          description: "Allocate a PTY for background execution."
        }
      }),
      ...(options.handoff === true ? {
        lifecycle: {
          type: "string",
          enum: ["session", "deliverable"],
          description:
            "Defaults to session. Use deliverable only for a verified service that must survive successful completion, then call process_handoff."
        }
      } : {})
    })
  };
}

function executionEffects(
  validation: boolean,
  unified: boolean
): ToolDescriptor["possibleEffects"] {
  return validation
    ? [
        "process.spawn", "process.spawn.readonly", "filesystem.read",
        "filesystem.read.external", "filesystem.write", "validation",
        "network", "open_world"
      ]
    : [
        "process.spawn", "process.spawn.readonly", "filesystem.read",
        "filesystem.read.external", "filesystem.write",
        ...(unified ? ["validation" as const] : []),
        "network", "open_world"
      ];
}

function executionDescription(
  kind: ForegroundKind,
  options: ExecutionToolOptions
): string {
  if (kind === "validate") {
    return "Run a sandboxed validation using exactly one form: {executable,args} or {shell,command}. The runtime freezes the declared intent and objective command result; an independent reviewer decides semantic coverage.";
  }
  if (kind !== "shell") {
    return `Run a sandboxed ${kind} command. With skill and skillScript, the frozen script is prepended to interpreter args.`;
  }
  return [
    "Run one sandboxed command using exactly one form: {command,shell?} or {executable,args?,skill?,skillScript?}. Foreground is the default. A completed check may be marked by validation=true or by supplying purpose, subjects, or criterionIds; background=true is only for a long-running service or interactive process. Background startup waits up to yieldMs and returns either terminal status or a live handle.",
    ...(environmentShellAvailable(options)
      ? ["Set target=environment only for system-level changes in the broker-attested disposable outer environment."]
      : [])
  ].join(" ");
}

export function foregroundExecutionSchema(
  kind: ForegroundKind,
  options: ExecutionToolOptions,
  network: JsonValue
): { schema: ToolDescriptor; validation: boolean } {
  const validation = kind === "validate";
  const unified = kind === "shell";
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
    ...(validation ? validationIntentProperties() : {}),
    ...(unified ? unifiedExecutionProperties(options) : {}),
    ...writeContractProperties(options)
  };
  const required = validation || kind === "shell" ? [] : ["executable"];
  const base = executionToolSchema(
    kind,
    executionDescription(kind, options),
    properties,
    required,
    executionEffects(validation, unified)
  );
  const schema = validation || kind === "shell"
    ? { ...base, inputSchema: invocationSchema(base, kind, availableShells(options).length > 0) }
    : base;
  return { schema, validation };
}
