import type { JsonValue, ToolDescriptor } from "agent-protocol";
import { runtimeEnvironment, type ShellKind } from "agent-platform";
import type { ExecutionToolOptions } from "./execution-tool-types.js";

export function executionArgs(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  const fallback = runtimeEnvironment().defaultShell;
  return [...new Set(options.shells ?? (fallback === "none" ? [] : [fallback]))];
}

export function assertAvailableShell(input: Record<string, JsonValue>, options: ExecutionToolOptions): void {
  const requested = executionText(input, "shell");
  if (availableShells(options).includes(requested as ShellKind)) return;
  throw Object.assign(new Error(`Shell '${requested}' is not verified by the execution broker.`), {
    code: "shell_unavailable"
  });
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
  if (shell === "powershell") {
    return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  if (shell === "cmd") {
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", `chcp 65001>nul & ${command}`] };
  }
  if (shell === "bash") return { executable: "bash", args: ["-lc", command] };
  throw new Error(`Unsupported shell '${shell}'.`);
}
