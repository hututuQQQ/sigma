import path from "node:path";
import type { JsonValue } from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import {
  availableShells,
  executionArgs
} from "./execution-tool-values.js";

function enclosingContainerRoot(workspacePath: string): string {
  return path.parse(path.resolve(workspacePath)).root;
}

export function environmentShellArguments(
  value: JsonValue,
  workspacePath: string
): Record<string, JsonValue> {
  const { target: _target, ...input } = executionArgs(value);
  const root = enclosingContainerRoot(workspacePath);
  return {
    ...input,
    access: "write",
    writeRoots: [root],
    expectedChanges: [root]
  };
}

export function environmentShellAvailable(options: ExecutionToolOptions): boolean {
  return options.foreground !== false
    && options.readScope === "host"
    && options.writeScope === "enclosing-container"
    && options.enclosingContainerRoot === true
    && Boolean(options.enclosingContainerAttestationDigest)
    && availableShells(options).length > 0;
}
