import path from "node:path";
import type { JsonValue } from "agent-protocol";
import { isInside, resolveWorkspacePath } from "agent-platform";
import {
  processMutationContract,
  writePlanError
} from "./process-mutation-contract.js";

function expectedChangePaths(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw writePlanError(
      "Tool argument 'expectedChanges' must be a string array.",
      "write_plan_invalid"
    );
  }
  const values = [...new Set(value as string[])];
  if (values.some((item) => item.length === 0)) {
    throw writePlanError(
      "expectedChanges entries must be non-empty paths.",
      "write_plan_invalid"
    );
  }
  return values;
}

export async function environmentWorkspaceMutation(
  expectedChanges: JsonValue | undefined,
  workspacePath: string,
  runMode: "analyze" | "change",
  background: boolean
): Promise<Awaited<ReturnType<typeof processMutationContract>> | undefined> {
  const declared = expectedChangePaths(expectedChanges);
  if (declared.length === 0) return undefined;
  const workspaceRoot = await resolveWorkspacePath(workspacePath, ".");
  const workspaceChanges = declared.filter((item) => {
    const target = path.isAbsolute(item)
      ? path.resolve(item) : path.resolve(workspaceRoot, item);
    return isInside(workspaceRoot, target);
  });
  if (workspaceChanges.length === 0) return undefined;
  return await processMutationContract(
    { expectedChanges: workspaceChanges },
    workspacePath,
    runMode,
    background,
    "workspace"
  );
}
