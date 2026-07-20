import { afterEach, describe, expect, it } from "vitest";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrokerExecutableUnavailableError,
  BrokerToolchainUnavailableError
} from "../packages/agent-execution/src/errors.js";
import { resolvePortableNodeExecutable } from "../packages/agent-execution/src/paths.js";
import { requestParams } from "../packages/agent-execution/src/broker-request-policy.js";
import {
  applyTrustedToolchains,
  assertTrustedToolchainsAvailable,
  normalizeTrustedToolchains
} from "../packages/agent-execution/src/trusted-toolchains.js";
import type {
  ProcessSpawnRequest,
  SigmaExecBrokerClientOptions
} from "../packages/agent-execution/src/types.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function request(executable: string, cwd: string, executionRoots: string[] = []): ProcessSpawnRequest {
  return {
    command: { executable, cwd },
    policy: {
      sandbox: "required",
      network: "none",
      readRoots: [cwd],
      writeRoots: [],
      executionRoots
    }
  };
}

function clientOptions(sandboxMode: "required" | "unsafe"): SigmaExecBrokerClientOptions {
  return { helperPath: process.execPath, sandboxMode };
}

function portableExecutableName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

async function portableLayout(): Promise<{
  bundleRoot: string;
  moduleUrl: URL;
  executable: string;
}> {
  const bundleRoot = await temporaryRoot("sigma-portable-path-");
  const modulePath = path.join(bundleRoot, "packages", "runtime", "dist", "index.js");
  const executable = path.join(bundleRoot, "bin", portableExecutableName());
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(modulePath, "export {};\n");
  await writeFile(executable, "portable runtime\n");
  return { bundleRoot, moduleUrl: pathToFileURL(modulePath), executable };
}

describe("trusted toolchain boundaries", () => {
  it("forwards only the opaque id of a local one-use repository metadata lease", async () => {
    const workspace = await temporaryRoot("sigma-repository-metadata-wire-");
    const value = request("git", workspace);
    value.policy.readRoots = [workspace];
    value.policy.writeRoots = [workspace];
    value.policy.repositoryMetadataLease = {
      protocolVersion: 1,
      leaseId: "broker-issued-one-use",
      repositoryRoot: workspace,
      gitDir: path.join(workspace, ".git"),
      commonDir: path.join(workspace, ".git"),
      executable: "git",
      executableSha256: "a".repeat(64),
      network: "none",
      uses: 1
    };
    const wired = requestParams(value, clientOptions("required"), [], []);
    expect(wired.policy).toMatchObject({
      repositoryMetadataLeaseId: "broker-issued-one-use",
      network: "none"
    });
    expect(wired.policy).not.toHaveProperty("repositoryMetadataLease");
  });

  it("defaults a generic toolchain to its exact executable without extending PATH", () => {
    const executable = path.resolve("tools", process.platform === "win32" ? "compiler.exe" : "compiler");
    const toolchains = normalizeTrustedToolchains([{
      id: "compiler",
      runtime: "generic",
      executable
    }]);

    expect(toolchains).toHaveLength(1);
    expect(toolchains[0]).toMatchObject({
      executable,
      executionRoots: [executable],
      pathEntries: []
    });
    expect(applyTrustedToolchains({ PATH: "inherited-path" }, toolchains).PATH).toBe("inherited-path");
  });

  it("mounts exact-entry runtime dependencies read-only without authorizing sibling executables", async () => {
    const root = await temporaryRoot("sigma-toolchain-runtime-roots-");
    const workspace = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "lib");
    const executable = path.join(root, "bin", portableExecutableName());
    const sibling = path.join(runtimeRoot, process.platform === "win32" ? "helper.exe" : "helper");
    await mkdir(workspace);
    await mkdir(runtimeRoot);
    await mkdir(path.dirname(executable));
    await writeFile(executable, "runtime\n");
    await writeFile(sibling, "helper\n");
    const toolchains = normalizeTrustedToolchains([{
      id: "runtime-node",
      runtime: "node",
      executable,
      aliases: ["node"],
      executionRoots: [executable],
      runtimeRoots: [runtimeRoot]
    }]);

    const wired = requestParams(request("node", workspace), clientOptions("unsafe"), toolchains, []);
    expect(wired).toMatchObject({
      policy: {
        readRoots: [workspace, runtimeRoot],
        writeRoots: [],
        executionRoots: [executable]
      }
    });
    expect(() => requestParams(
      request(sibling, workspace), clientOptions("unsafe"), toolchains, []
    )).toThrow(BrokerExecutableUnavailableError);
  });

  it.runIf(process.platform !== "win32")(
    "includes a declared runtime root's canonical symlink target without widening execution trust",
    async () => {
      const root = await temporaryRoot("sigma-toolchain-runtime-symlink-");
      const workspace = path.join(root, "workspace");
      const realRuntime = path.join(root, "real-runtime");
      const linkedRuntime = path.join(root, "linked-runtime");
      const executable = path.join(root, "bin", portableExecutableName());
      await mkdir(workspace);
      await mkdir(realRuntime);
      await mkdir(path.dirname(executable));
      await writeFile(executable, "runtime\n");
      await symlink(realRuntime, linkedRuntime, "dir");
      const toolchains = normalizeTrustedToolchains([{
        id: "runtime-symlink", runtime: "node", executable, aliases: ["node"],
        executionRoots: [executable], runtimeRoots: [linkedRuntime]
      }]);
      const wired = requestParams(request("node", workspace), clientOptions("unsafe"), toolchains, []);
      expect((wired.policy as { readRoots: string[] }).readRoots).toEqual([
        workspace, linkedRuntime, await realpath(realRuntime)
      ]);
      expect((wired.policy as { executionRoots: string[] }).executionRoots).toEqual([executable]);
    }
  );

  it.runIf(process.platform !== "win32")(
    "canonicalizes an absolute symlink only when its target is an exact verified executable",
    async () => {
      const root = await temporaryRoot("sigma-verified-executable-alias-");
      const workspace = path.join(root, "workspace");
      const verified = path.join(root, "verified-shell");
      const alias = path.join(root, "shell-alias");
      const untrusted = path.join(root, "untrusted-shell");
      const untrustedAlias = path.join(root, "untrusted-alias");
      await mkdir(workspace);
      await writeFile(verified, "verified\n");
      await writeFile(untrusted, "untrusted\n");
      await symlink(verified, alias);
      await symlink(untrusted, untrustedAlias);

      const wired = requestParams(request(alias, workspace), clientOptions("required"), [], [verified]);
      expect(wired).toMatchObject({ command: { executable: await realpath(verified) } });
      expect(() => requestParams(
        request(untrustedAlias, workspace), clientOptions("required"), [], [verified]
      )).toThrow(BrokerExecutableUnavailableError);
    }
  );

  it("does not let a broad descendant root establish a sibling as the primary executable", async () => {
    const root = await temporaryRoot("sigma-toolchain-primary-");
    const entryPoint = path.join(root, process.platform === "win32" ? "compiler.exe" : "compiler");
    const sibling = path.join(root, process.platform === "win32" ? "helper.exe" : "helper");
    await writeFile(entryPoint, "entry point\n");
    await writeFile(sibling, "helper\n");
    if (process.platform !== "win32") await chmod(entryPoint, 0o755);
    const toolchains = normalizeTrustedToolchains([{
      id: "compiler",
      runtime: "generic",
      executable: entryPoint,
      executionRoots: [root],
      pathEntries: [root]
    }]);

    expect(() => assertTrustedToolchainsAvailable(toolchains, "unsafe")).not.toThrow();
    expect(() => requestParams(
      request(path.basename(sibling), root),
      clientOptions("unsafe"),
      toolchains,
      []
    )).toThrow(BrokerExecutableUnavailableError);
    expect(() => requestParams(
      request(`.${path.sep}${path.basename(sibling)}`, root),
      clientOptions("unsafe"),
      toolchains,
      []
    )).toThrow(BrokerExecutableUnavailableError);
  });

  it.runIf(process.platform === "win32")(
    "rejects a broad generic toolchain before starting a required Windows sandbox",
    async () => {
      const root = await temporaryRoot("sigma-toolchain-required-");
      const entryPoint = path.join(root, "compiler.exe");
      await writeFile(entryPoint, "entry point\n");
      const toolchains = normalizeTrustedToolchains([{
        id: "compiler",
        runtime: "generic",
        executable: entryPoint,
        executionRoots: [root],
        pathEntries: []
      }]);

      expect(() => assertTrustedToolchainsAvailable(toolchains, "required"))
        .toThrow(BrokerToolchainUnavailableError);
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects an undeclared Node sibling even when a primary policy names the broad root",
    async () => {
      const root = await temporaryRoot("sigma-toolchain-node-sibling-");
      const entryPoint = path.join(root, "compiler.exe");
      const sibling = path.join(root, "runtime.bin");
      await writeFile(entryPoint, "entry point\n");
      await cp(process.execPath, sibling);
      const toolchains = normalizeTrustedToolchains([{
        id: "compiler",
        runtime: "generic",
        executable: entryPoint,
        executionRoots: [root],
        pathEntries: []
      }]);

      expect(() => requestParams(
        request(sibling, root, [root]),
        clientOptions("required"),
        toolchains,
        []
      )).toThrow(BrokerToolchainUnavailableError);
    }
  );
});

describe("portable runtime path containment", () => {
  it("returns only the regular executable in the canonical bundle bin directory", async () => {
    const layout = await portableLayout();

    expect(resolvePortableNodeExecutable(layout.moduleUrl)).toBe(await realpath(layout.executable));
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked executable that escapes the bundle bin directory",
    async () => {
      const layout = await portableLayout();
      const externalRoot = await temporaryRoot("sigma-portable-external-");
      const externalExecutable = path.join(externalRoot, portableExecutableName());
      await writeFile(externalExecutable, "external runtime\n");
      await rm(layout.executable);
      await symlink(externalExecutable, layout.executable, "file");

      expect(resolvePortableNodeExecutable(layout.moduleUrl)).toBeUndefined();
    }
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked bin path that escapes the canonical bundle",
    async () => {
      const layout = await portableLayout();
      const externalRoot = await temporaryRoot("sigma-portable-external-bin-");
      await writeFile(path.join(externalRoot, portableExecutableName()), "external runtime\n");
      await rm(path.join(layout.bundleRoot, "bin"), { recursive: true });
      await symlink(externalRoot, path.join(layout.bundleRoot, "bin"), "dir");

      expect(resolvePortableNodeExecutable(layout.moduleUrl)).toBeUndefined();
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects a bin junction that escapes the canonical bundle",
    async () => {
      const layout = await portableLayout();
      const externalRoot = await temporaryRoot("sigma-portable-external-bin-");
      await writeFile(path.join(externalRoot, portableExecutableName()), "external runtime\n");
      await rm(path.join(layout.bundleRoot, "bin"), { recursive: true });
      await symlink(externalRoot, path.join(layout.bundleRoot, "bin"), "junction");

      expect(resolvePortableNodeExecutable(layout.moduleUrl)).toBeUndefined();
    }
  );
});
