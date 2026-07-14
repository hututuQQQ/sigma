import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { standardRuntimeNodePath } from "../scripts/run-tui-deepseek.mjs";

const fixtures: string[] = [];

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([
  ["linux", "x64", "node"],
  ["win32", "arm64", "node.exe"]
] as const)("selects an existing standard %s development runtime", async (platform, architecture, name) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-tui-runtime-node-"));
  fixtures.push(root);
  const executable = path.join(
    root, ".artifacts", `agent-cli-${platform}-${architecture}`, "bin", name
  );
  expect(standardRuntimeNodePath(root, platform, architecture)).toBeUndefined();
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "runtime node", "utf8");
  expect(standardRuntimeNodePath(root, platform, architecture)).toBe(path.resolve(executable));
});
