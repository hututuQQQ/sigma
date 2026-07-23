import type { JsonValue, ToolDescriptor } from "agent-protocol";
import {
  normalizeWindowsShellInvocation,
  shellInvocation as platformShellInvocation,
  type ShellKind
} from "agent-platform";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import { assertObjectArguments } from "./tool-argument-validation.js";

export function executionArgs(value: JsonValue): Record<string, JsonValue> {
  assertObjectArguments(value, "Execution tool");
  return value;
}

export function executionText(input: Record<string, JsonValue>, key: string, fallback?: string): string {
  const value = input[key] ?? fallback;
  if (typeof value !== "string" || !value) throw new Error(`Tool argument '${key}' must be a non-empty string.`);
  return value;
}

export function executionStrings(input: Record<string, JsonValue>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Tool argument '${key}' must be a string array.`);
  }
  return [...value] as string[];
}

export function executionEnvironment(
  input: Record<string, JsonValue>
): { overrides?: Record<string, string> } | undefined {
  const raw = input.env;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("env must be an object of non-secret strings.");
  }
  const entries = Object.entries(raw);
  if (entries.some((entry) => typeof entry[1] !== "string")) throw new Error("env values must be strings.");
  return { overrides: Object.fromEntries(entries) as Record<string, string> };
}

export function availableShells(options: ExecutionToolOptions): ShellKind[] {
  return [...new Set(options.shells ?? [])];
}

export function resolvedShell(
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions
): ShellKind {
  const available = availableShells(options);
  const explicit = input.shell;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || !available.includes(explicit as ShellKind)) {
      throw Object.assign(new Error(
        `Shell '${String(explicit)}' is not verified by the execution broker. Valid form: {"command":"...","shell":${JSON.stringify(available[0] ?? "bash")}}.`
      ), { code: "shell_unavailable" });
    }
    return explicit as ShellKind;
  }
  const platform = options.executionPlatform ?? process.platform;
  const preference: ShellKind[] = platform === "win32"
    ? ["powershell", "cmd", "bash"]
    : ["bash", "powershell", "cmd"];
  const selected = preference.find((shell) => available.includes(shell));
  if (selected) return selected;
  throw Object.assign(new Error(
    "No verified shell is available. Valid form requires {\"command\":\"...\"} and a broker-provided shell."
  ), { code: "shell_unavailable" });
}

export function availableRuntimeCommands(options: ExecutionToolOptions): string[] {
  return [...new Set((options.runtimeCommands ?? [])
    .filter((command) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command)))]
    .sort((left, right) => left.localeCompare(right));
}

export function executableCapabilityDescription(options: ExecutionToolOptions): string {
  if (options.managedEnvironment === true) {
    return "Bare executable aliases are resolved and authenticated inside the launcher-attested managed target. A missing alias returns a structured dependency observation; do not infer availability from stderr.";
  }
  const commands = availableRuntimeCommands(options);
  const aliasDescription = commands.length > 0
    ? `Connection-verified bare runtime command alias. Available aliases: ${commands.join(", ")}. Unlisted bare commands are unavailable.`
    : "No general bare runtime command alias is verified for this connection; do not guess or retry host commands.";
  return `${aliasDescription} An explicit executable path containing a path separator remains available to broker policy validation.`;
}

export function executableCapabilitySchema(options: ExecutionToolOptions): JsonValue {
  const commands = availableRuntimeCommands(options);
  const managedAlias = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$" };
  const windows = (options.executionPlatform ?? process.platform) === "win32";
  const explicitPath = {
    type: "string",
    pattern: windows ? "[\\\\/]" : "/"
  };
  return {
    type: "string",
    ...(options.managedEnvironment === true
      ? { anyOf: [managedAlias, explicitPath] }
      : commands.length > 0
      ? { anyOf: [{ type: "string", enum: commands }, explicitPath] }
      : { pattern: explicitPath.pattern }),
    description: executableCapabilityDescription(options)
  };
}

export function assertAvailableExecutable(
  input: Record<string, JsonValue>,
  options: ExecutionToolOptions
): void {
  const requested = executionText(input, "executable");
  const explicitPath = (options.executionPlatform ?? process.platform) === "win32" ? /[\\/]/u : /\//u;
  if (explicitPath.test(requested)) return;
  if (options.managedEnvironment === true
    && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(requested)) return;
  const windows = (options.executionPlatform ?? process.platform) === "win32";
  const key = windows ? requested.toLowerCase() : requested;
  const available = availableRuntimeCommands(options);
  if (available.some((command) =>
    (windows ? command.toLowerCase() : command) === key)) return;
  throw Object.assign(new Error(
    `Executable alias '${requested}' is not verified for this broker connection.`
  ), { code: "executable_unavailable" });
}

export function availableNetworkModes(options: ExecutionToolOptions): Array<"none" | "loopback" | "full"> {
  return [...new Set((options.networkModes ?? ["none"])
    .filter((mode): mode is "none" | "loopback" | "full" =>
      mode === "none" || mode === "loopback" || mode === "full"))];
}

export function assertAvailableShell(input: Record<string, JsonValue>, options: ExecutionToolOptions): void {
  resolvedShell(input, options);
}

export function executionToolSchema(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: string[],
  effects: ToolDescriptor["possibleEffects"],
  availableModes: ToolDescriptor["availableModes"] = ["analyze", "change"]
): ToolDescriptor {
  return {
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    possibleEffects: effects,
    maximumEffects: effects,
    availableModes,
    executionMode: "exclusive",
    resourceKeys: ["workspace:process"],
    approval: "prompt",
    idempotent: false,
    // Broker-managed foreground commands enforce a 600s command deadline and
    // 120s output-idle deadline. The outer deadline also covers broker startup
    // plus bounded pre/post Git observation, so it is deliberately well behind
    // the broker request grace. No blind outer idle timer is installed.
    timeoutMs: 750_000
  };
}

export function shellInvocation(shell: string, command: string): { executable: string; args: string[] } {
  if (shell === "powershell" || shell === "cmd" || shell === "bash") {
    return platformShellInvocation(shell, command);
  }
  throw new Error(`Unsupported shell '${shell}'.`);
}

export { normalizeWindowsShellInvocation };
