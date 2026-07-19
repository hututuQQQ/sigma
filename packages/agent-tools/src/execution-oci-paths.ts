import path from "node:path";
import type { ExecutionIntentV1 } from "agent-protocol";
import { isInside, resolveWorkspacePath } from "agent-platform";
import type { ExecutionToolOptions } from "./execution-tool-types.js";

function executableHasPath(executable: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /[\\/]/u.test(executable) : executable.includes("/");
}

/** Derive execute authority only for files in the shared OCI workspace.
 * Target system paths stay target-owned and are validated by its sandbox. */
export async function ociWorkspaceExecutableRoots(
  invocation: ExecutionIntentV1["invocation"],
  workspaceRoot: string,
  options: ExecutionToolOptions
): Promise<string[]> {
  if (options.executionBackend !== "oci") return [];
  const platform = options.executionPlatform ?? process.platform;
  if (!executableHasPath(invocation.executable, platform)) return [];
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  if (platform !== process.platform) {
    if (targetPath.isAbsolute(invocation.executable)) return [];
    throw Object.assign(new Error(
      "A relative OCI workspace executable requires control and target path semantics to match."
    ), {
      code: "execution_platform_mismatch",
      controlPlatform: process.platform,
      targetPlatform: platform
    });
  }
  const cwd = path.isAbsolute(invocation.cwd)
    ? path.resolve(invocation.cwd) : path.resolve(workspaceRoot, invocation.cwd);
  const candidate = path.isAbsolute(invocation.executable)
    ? path.resolve(invocation.executable) : path.resolve(cwd, invocation.executable);
  if (!isInside(workspaceRoot, candidate)) return [];
  return [await resolveWorkspacePath(workspaceRoot, candidate)];
}
