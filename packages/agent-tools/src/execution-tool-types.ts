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
