import type { ExecutionBroker } from "agent-execution";
import type { ShellKind } from "agent-platform";

export function resolveCommandTimeoutSec(value: number | undefined): number {
  const resolved = value ?? 600;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 2_147_000) {
    throw new Error("commandTimeoutSec must be a positive integer no greater than 2147000.");
  }
  return resolved;
}

export interface ExecutionToolOptions {
  broker: ExecutionBroker;
  commandTimeoutSec?: number;
  /** Authenticated process boundary. OCI enables target-side executable
   * resolution; native execution remains closed to verified aliases. */
  executionBackend?: "native" | "oci";
  executionPlatform?: NodeJS.Platform;
  sandboxMode: "required";
  readScope: "workspace" | "host";
  processHandoff: "allow" | "deny";
  networkMode: "none" | "loopback" | "full";
  shells?: readonly ShellKind[];
  runtimeCommands?: readonly string[];
  foreground?: boolean;
  background?: boolean;
  stdin?: boolean;
  pty?: boolean;
  handoff?: boolean;
  networkModes?: readonly ("none" | "loopback" | "full")[];
}
