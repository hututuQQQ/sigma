import type { ExecutionBroker } from "agent-execution";
import type { ShellKind } from "agent-platform";

export interface ExecutionToolOptions {
  broker: ExecutionBroker;
  /** Authenticated process boundary. OCI resolves bare commands in the target,
   * never through the control process PATH. */
  executionBackend?: "native" | "oci";
  executionPlatform?: NodeJS.Platform;
  managedEnvironment?: boolean;
  sandboxMode: "required";
  readScope: "workspace" | "host";
  writeScope?: "workspace" | "enclosing-container";
  enclosingContainerRoot?: boolean;
  enclosingContainerAttestationDigest?: string;
  /** Runtime-owned paths that remain read-only during enclosing-container
   * mutation. They are never accepted from model arguments. */
  protectedPaths?: readonly string[];
  processHandoff: "allow" | "deny";
  networkMode: "none" | "loopback" | "full";
  /** Product-configured default for foreground commands. Per-call timeouts can
   * still narrow or extend it within the tool's fixed 600 second safety cap. */
  commandTimeoutMs?: number;
  shells?: readonly ShellKind[];
  runtimeCommands?: readonly string[];
  directExecutableResolution?: boolean;
  foreground?: boolean;
  background?: boolean;
  stdin?: boolean;
  pty?: boolean;
  handoff?: boolean;
  networkModes?: readonly ("none" | "loopback" | "full")[];
}
