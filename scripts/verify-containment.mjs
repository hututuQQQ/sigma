#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const entry = path.resolve("packages", "agent-platform", "dist", "index.js");
  const executionEntry = path.resolve("packages", "agent-execution", "dist", "index.js");
  if (!existsSync(entry)) throw new Error("packages/agent-platform/dist/index.js not found. Run pnpm build first.");
  if (!existsSync(executionEntry)) throw new Error("packages/agent-execution/dist/index.js not found. Run pnpm build first.");
  const { resolveWorkspacePath, runProcess, runtimeEnvironment } = await import(pathToFileURL(entry).href);
  const { SigmaExecBrokerClient } = await import(pathToFileURL(executionEntry).href);
  const helperPath = path.resolve(
    "native", "sigma-exec", "target", "debug", process.platform === "win32" ? "sigma-exec.exe" : "sigma-exec"
  );
  if (!existsSync(helperPath)) throw new Error(`Native broker not found at ${helperPath}. Run cargo build first.`);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-platform-verify-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "sigma-platform-external-"));
  const execution = new SigmaExecBrokerClient({
    helperPath,
    sandboxMode: "unsafe",
    allowUnsafeHostExec: false
  });
  try {
    await execution.connect();
    await execution.setupSandbox();
    await writeFile(path.join(external, "secret.txt"), "secret", "utf8");
    await resolveWorkspacePath(workspace, "safe.txt");
    await resolveWorkspacePath(workspace, "../escape.txt").then(
      () => { throw new Error("Lexical workspace escape was allowed."); },
      () => undefined
    );
    try {
      await symlink(external, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
      await resolveWorkspacePath(workspace, "linked/secret.txt").then(
        () => { throw new Error("Linked workspace escape was allowed."); },
        () => undefined
      );
    } catch (error) {
      if (existsSync(path.join(workspace, "linked"))) throw error;
    }

    const controller = new AbortController();
    const executable = process.execPath;
    const started = Date.now();
    const pending = runProcess({
      execution,
      executable,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: workspace,
      timeoutMs: 30_000,
      signal: controller.signal,
      readRoots: [workspace, path.dirname(executable)]
    });
    setTimeout(() => controller.abort(new Error("verification cancel")), 25);
    const result = await pending;
    if (!result.cancelled || Date.now() - started >= 1_000) throw new Error(`Process cancellation was too slow: ${JSON.stringify(result)}`);
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    process.stdout.write(`PASS platform containment and cancellation (${runtimeEnvironment().platform}/${runtimeEnvironment().defaultShell})\n`);
  } finally {
    await execution.close();
    await Promise.all([
      rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      rm(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    ]);
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
