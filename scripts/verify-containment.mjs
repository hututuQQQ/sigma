#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const entry = path.resolve("packages", "agent-platform", "dist", "index.js");
  if (!existsSync(entry)) throw new Error("packages/agent-platform/dist/index.js not found. Run pnpm build first.");
  const { resolveWorkspacePath, runProcess, runtimeEnvironment } = await import(pathToFileURL(entry).href);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-platform-verify-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "sigma-platform-external-"));
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
  const pending = runProcess({ executable, args: ["-e", "setInterval(() => {}, 1000)"], cwd: workspace, timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("verification cancel")), 25);
  const result = await pending;
  if (!result.cancelled || Date.now() - started >= 1_000) throw new Error(`Process cancellation was too slow: ${JSON.stringify(result)}`);
  await mkdir(path.join(workspace, ".agent"), { recursive: true });
  process.stdout.write(`PASS platform containment and cancellation (${runtimeEnvironment().platform}/${runtimeEnvironment().defaultShell})\n`);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
