import type { ExecutionPolicy } from "agent-execution";
import type { ExecutionToolOptions } from "./execution-tool-types.js";

export function validationWorkspacePolicy(
  validation: boolean,
  workspaceRoot: string,
  options: ExecutionToolOptions
): Pick<ExecutionPolicy, "disposableWorkspaceRoot" | "readOnlyValidationWorkspaceRoot"> {
  if (!validation) return {};
  return (options.executionPlatform ?? process.platform) === "win32"
    ? { readOnlyValidationWorkspaceRoot: workspaceRoot }
    : { disposableWorkspaceRoot: workspaceRoot };
}
