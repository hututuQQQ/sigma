import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertBrokerTarget,
  assertMetadata,
  parseArguments,
  portableLayout,
  portableNodeToolchain
} from "../scripts/ci/lsp-sandbox-smoke.mjs";

const execFileAsync = promisify(execFile);

async function fileDigest(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("bundled LSP sandbox smoke", () => {
  it("accepts canonical broker aliases for Apple Silicon", () => {
    expect(() => assertBrokerTarget(
      { platform: "macos", architecture: "aarch64" }, "darwin", "arm64"
    )).not.toThrow();
    expect(() => assertBrokerTarget(
      { platform: "darwin", architecture: "x86_64" }, "darwin", "arm64"
    )).toThrow("does not match arm64");
  });

  it("resolves portable inputs without host PATH assumptions", () => {
    expect(parseArguments([
      "--bundle", "release",
      "--broker", "release/bin/sigma-exec",
      "--target-platform", "linux",
      "--output", "evidence.json"
    ])).toEqual({
      bundle: "release",
      broker: "release/bin/sigma-exec",
      targetPlatform: "linux",
      output: "evidence.json"
    });
    expect(portableLayout("release", "win32")).toMatchObject({
      node: path.resolve("release", "bin", "node.exe"),
      typescriptEntry: path.resolve("release", "node_modules", "agent-code-intel", "dist", "typescript-server.mjs"),
      pyrightEntry: path.resolve("release", "node_modules", "pyright", "langserver.index.js"),
      mcpModule: path.resolve("release", "node_modules", "agent-mcp", "dist", "index.js")
    });
    expect(parseArguments([
      "--bundle", "release", "--broker", "broker", "--target-platform", "darwin", "--output", "out"
    ])).toMatchObject({ targetPlatform: "darwin" });
    expect(() => parseArguments([
      "--bundle", "release", "--broker", "broker", "--target-platform", "freebsd", "--output", "out"
    ])).toThrow("--target-platform must be 'linux', 'win32', or 'darwin'");
  });

  it("binds the exact bundled Node runtime to its Windows compatibility proof", () => {
    const layout = portableLayout("release", "win32");
    const contract = {
      kind: "windows_appcontainer_node",
      patchId: "patch-v1",
      reason: "fixture",
      nodeVersion: "v1.2.3",
      targetPlatform: "win32",
      targetArch: "x64",
      sourceSha256: "a".repeat(64),
      unsignedPatchedSha256: "d".repeat(64),
      normalizedContentSha256: "b".repeat(64),
      requiredNodeOptions: "--preserve-symlinks --preserve-symlinks-main"
    };
    const nodeDigest = "c".repeat(64);
    const proof = {
      kind: contract.kind,
      patchId: contract.patchId,
      sourceSha256: contract.sourceSha256,
      normalizedContentSha256: contract.normalizedContentSha256,
      executableSha256: nodeDigest
    };
    const api = {
      WINDOWS_APPCONTAINER_NODE_COMPATIBILITY: contract,
      createWindowsAppContainerNodeCompatibilityProof: (executable: string, id: string) => {
        expect(executable).toBe(layout.node);
        expect(id).toBe("bundled-runtime");
        return proof;
      }
    };
    const compatibility = {
      kind: contract.kind,
      patchId: contract.patchId,
      reason: contract.reason,
      nodeVersion: contract.nodeVersion,
      targetPlatform: contract.targetPlatform,
      targetArch: contract.targetArch,
      sourceSha256: contract.sourceSha256,
      unsignedPatchedSha256: contract.unsignedPatchedSha256,
      normalizedContentSha256: contract.normalizedContentSha256,
      runtimeEnvironment: { NODE_OPTIONS: "--preserve-symlinks-main" },
      sandboxRuntimeEnvironment: { NODE_OPTIONS: contract.requiredNodeOptions }
    };
    const metadata = {
      targetPlatform: "win32",
      node: { sha256: nodeDigest, compatibility }
    };
    const integrity = { nodeCompatibility: structuredClone(compatibility) };
    expect(portableNodeToolchain(api, layout, metadata, integrity, nodeDigest)).toEqual({
      id: "bundled-runtime",
      runtime: "node",
      executable: layout.node,
      aliases: ["node", "node.exe"],
      executionRoots: [layout.node],
      pathEntries: [],
      environment: { NODE_OPTIONS: contract.requiredNodeOptions },
      compatibility: proof
    });
    expect(() => portableNodeToolchain(api, layout, {
      ...metadata,
      node: { compatibility: {
        ...compatibility,
        sandboxRuntimeEnvironment: { NODE_OPTIONS: "--inspect" }
      }, sha256: nodeDigest }
    }, integrity, nodeDigest)).toThrow("does not match the integrity manifest");
  });

  it("requires schema 1 metadata with the manifest product version", () => {
    const layout = portableLayout("release", "win32");
    const broker = path.join(layout.bundle, "bin", "sigma-exec.exe");
    const digest = "a".repeat(64);
    const metadata = {
      schemaVersion: 1,
      productVersion: "0.1.7",
      targetPlatform: "win32",
      targetArch: "x64",
      sigmaExec: { path: "bin/sigma-exec.exe", sha256: digest }
    };
    expect(() => assertMetadata(metadata, "win32", broker, digest, layout)).not.toThrow();
    expect(() => assertMetadata(
      { ...metadata, schemaVersion: 999 }, "win32", broker, digest, layout
    )).toThrow("unsupported_schema_version");
    expect(() => assertMetadata(
      { ...metadata, productVersion: "0.1.1" }, "win32", broker, digest, layout
    )).toThrow("must match sigma-manifest.json productVersion '0.1.7'");
  });

  it("rejects unknown package metadata without rewriting the artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-package-metadata-schema-"));
    const metadataPath = path.join(root, "package-metadata.json");
    const metadata = {
      schemaVersion: 999,
      productVersion: "0.1.7",
      targetPlatform: "win32",
      targetArch: "x64",
      sigmaExec: { path: "bin/sigma-exec.exe", sha256: "a".repeat(64) }
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
    const before = await fileDigest(metadataPath);
    const layout = portableLayout(root, "win32");
    const parsed = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(() => assertMetadata(
      parsed,
      "win32",
      path.join(layout.bundle, "bin", "sigma-exec.exe"),
      "a".repeat(64),
      layout
    )).toThrow("unsupported_schema_version");
    expect(await fileDigest(metadataPath)).toBe(before);
  });

  it("removes stale evidence before reporting a failed smoke", async () => {
    const root = await mkdir(path.join(os.tmpdir(), `sigma-lsp-smoke-test-${Date.now()}-${Math.random()}`), { recursive: true });
    const output = path.join(root, "evidence.json");
    await writeFile(output, "stale", "utf8");
    try {
      await expect(execFileAsync(process.execPath, [
        path.join(process.cwd(), "scripts", "ci", "lsp-sandbox-smoke.mjs"),
        "--bundle", path.join(root, "missing-bundle"),
        "--broker", path.join(root, "missing-broker"),
        "--target-platform", "linux",
        "--output", output
      ])).rejects.toThrow();
      await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
