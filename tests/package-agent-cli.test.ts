import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageAgentCli, pinnedNodeVersion } from "../scripts/package-agent-cli.mjs";

async function writeBuiltPackage(rootDir: string, packageName: string) {
  const packageDir = path.join(rootDir, "packages", packageName);
  await mkdir(path.join(packageDir, "dist"), { recursive: true });
  await writeFile(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        type: "module",
        main: "./dist/index.js"
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeFakeNodeRuntimeTarball(tmpDir: string, arch = "x64") {
  const runtimeRoot = path.join(tmpDir, "runtime");
  const runtimeDirName = `node-${pinnedNodeVersion}-linux-${arch}`;
  const runtimeDir = path.join(runtimeRoot, runtimeDirName);
  await mkdir(path.join(runtimeDir, "bin"), { recursive: true });
  const nodePath = path.join(runtimeDir, "bin", "node");
  await writeFile(nodePath, "#!/usr/bin/env sh\necho fake-node\n", "utf8");
  await chmod(nodePath, 0o755);

  const tarball = path.join(tmpDir, "node-runtime.tgz");
  const result = spawnSync("tar", ["-czf", tarball, "-C", runtimeRoot, runtimeDirName], {
    encoding: "utf8"
  });
  expect(result.status, result.stderr).toBe(0);
  return tarball;
}

async function writePackageFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sigma-package-agent-cli-"));
  for (const packageName of ["agent-ai", "agent-core", "agent-cli"]) {
    await writeBuiltPackage(rootDir, packageName);
  }
  return rootDir;
}

describe("package-agent-cli", () => {
  it("creates the Linux x64 artifact with bin/agent and bundled node", async () => {
    const rootDir = await writePackageFixture();
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);

    const result = await packageAgentCli({
      rootDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        AGENT_TARGET_ARCH: "x64"
      }
    });

    expect(path.basename(result.outputPath)).toBe("agent-cli-linux-x64.tgz");
    await expect(stat(path.join(result.bundleDir, "bin", "agent"))).resolves.toBeTruthy();
    await expect(stat(path.join(result.bundleDir, "bin", "node"))).resolves.toBeTruthy();

    const wrapper = await readFile(path.join(result.bundleDir, "bin", "agent"), "utf8");
    expect(wrapper).toContain('if [ -x "$SCRIPT_DIR/node" ]; then');
    expect(wrapper).toContain('NODE="$SCRIPT_DIR/node"');
    expect(wrapper).toContain("elif command -v node >/dev/null 2>&1; then");
    expect(wrapper).toContain("Sigma agent cannot start: no bundled node and no system node found.");
    expect(wrapper).toContain('exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"');

    const listing = spawnSync("tar", ["-tzf", result.outputPath], { encoding: "utf8" });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain("agent-cli-linux-x64/bin/agent");
    expect(listing.stdout).toContain("agent-cli-linux-x64/bin/node");
    expect(listing.stdout).toContain("agent-cli-linux-x64/packages/agent-cli/dist/index.js");
    expect(listing.stdout).toContain("agent-cli-linux-x64/node_modules/agent-core/package.json");
  });

  it("fails clearly when no Node runtime tarball is provided or cached", async () => {
    const rootDir = await writePackageFixture();

    await expect(packageAgentCli({ rootDir, env: {} })).rejects.toThrow(/NODE_RUNTIME_TARBALL is required/);
  });
});
