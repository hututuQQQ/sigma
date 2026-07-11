import { runProcess, type ProcessExecutionPort } from "agent-platform";

export async function runGit(
  execution: ProcessExecutionPort | undefined,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  writeRoots: string[] = []
): Promise<string> {
  if (!execution) throw new Error("Workspace isolation requires an injected execution port.");
  const result = await runProcess({
    execution,
    executable: "git",
    args,
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
    signal: signal ?? new AbortController().signal,
    readRoots: [...new Set([cwd, ...writeRoots])],
    writeRoots
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Git exited with ${String(result.exitCode)}.`);
  }
  return result.stdout.trim();
}
