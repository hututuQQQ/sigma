import type { ExecutionBroker } from "agent-execution";
import type { ShellKind } from "agent-platform";

export interface ExecutionToolOptions {
  broker: ExecutionBroker;
  sandboxMode: "required" | "unsafe";
  networkMode: "none" | "full";
  shells?: readonly ShellKind[];
}
