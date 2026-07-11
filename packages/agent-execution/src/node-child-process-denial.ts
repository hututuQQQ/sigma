/**
 * Node bootstrap fragment for sandboxed helpers that must never create a
 * second-generation process. Process ownership remains in agent-execution.
 */
export const NODE_CHILD_PROCESS_DENIAL_BOOTSTRAP = String.raw`
const denyChildProcesses = process.argv.includes("--sigma-lsp-deny-child-process");
if (denyChildProcesses) {
  const childProcess = (await import("node:child_process")).default;
  const deniedChildProcess = () => {
    const error = new Error("Language-server child processes are denied by the Sigma sandbox policy.");
    error.code = "EACCES";
    throw error;
  };
  for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
    childProcess[name] = deniedChildProcess;
  }
  (await import("node:module")).syncBuiltinESMExports();
}
`;
