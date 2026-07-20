import type { ExecutionResult } from "agent-execution";

function commandSucceeded(result: ExecutionResult): boolean {
  return result.state === "exited" && result.exitCode === 0 && result.signal === null
    && !result.timedOut && !result.idleTimedOut && !result.cancelled
    && result.failure === undefined;
}

/** Stable language-level families only; command text and package identity are
 * excluded so convergence remains product- and task-invariant. */
export function dependencyDiagnostics(result: ExecutionResult): string[] {
  if (commandSucceeded(result)) return [];
  const output = `${result.stdout}\n${result.stderr}`;
  const missing = [
    /ModuleNotFoundError:\s*No module named/iu,
    /(?:Error:\s*)?Cannot find (?:package|module)\b/iu,
    /ERR_MODULE_NOT_FOUND/iu,
    /cannot load such file --/iu,
    /ClassNotFoundException\b/iu,
    /NoClassDefFoundError\b/iu
  ].some((pattern) => pattern.test(output));
  return missing ? ["command_dependency_missing"] : [];
}
