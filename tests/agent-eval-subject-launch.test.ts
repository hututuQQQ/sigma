import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySubjectLaunchEnvironment, createDevNodeLaunch, loadPackagedSubjectLaunch, subjectNodeLaunch
} from "../scripts/eval/subject-launch.mjs";
import {
  resolveTuiControllerPython, tuiControllerEnvironment, tuiSubjectCommand
} from "../scripts/eval/subject-tui.mjs";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function portableFile(root: string, relative: string, contents: string): Promise<Record<string, unknown>> {
  const filePath = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  const bytes = Buffer.from(contents);
  return { path: relative, size: bytes.length, sha256: sha256(bytes) };
}

async function packagedSubject(targetPlatform: "linux" | "win32"): Promise<{
  root: string;
  paths: { node: string; cli: string; broker: string; wrapper: string };
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-package-launch-"));
  temporary.push(root);
  const targetArch = "x64";
  const paths = {
    node: `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`,
    cli: "packages/agent-cli/dist/index.js",
    broker: `bin/${targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec"}`,
    wrapper: `bin/${targetPlatform === "win32" ? "agent.cmd" : "agent"}`
  };
  const packageValue = {
    name: `sigma-agent-cli-${targetPlatform}-${targetArch}`,
    version: "3.0.0",
    bin: { agent: `./${paths.wrapper}` }
  };
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageValue)}\n`, "utf8");
  const entries = await Promise.all([
    portableFile(root, paths.node, "bundled-node"),
    portableFile(root, paths.cli, "bundled-cli"),
    portableFile(root, paths.broker, "bundled-broker"),
    portableFile(root, paths.wrapper, "bundled-wrapper")
  ]);
  const compatibility = targetPlatform === "win32"
    ? { kind: "portable-node-test", runtimeEnvironment: { NODE_OPTIONS: "--preserve-symlinks-main" } }
    : undefined;
  const integrity = {
    schemaVersion: 1,
    algorithm: "sha256",
    targetPlatform,
    targetArch,
    ...(compatibility ? { nodeCompatibility: compatibility } : {}),
    entries
  };
  const integrityText = `${JSON.stringify(integrity, null, 2)}\n`;
  await writeFile(path.join(root, "integrity-manifest.json"), integrityText, "utf8");
  const byPath = new Map(entries.map((entry) => [String(entry.path), entry]));
  const node = byPath.get(paths.node)!;
  const broker = byPath.get(paths.broker)!;
  const metadata = {
    schemaVersion: 3,
    targetPlatform,
    targetArch,
    node: {
      sha256: node.sha256,
      size: node.size,
      ...(compatibility ? { compatibility } : {})
    },
    sigmaExec: { path: paths.broker, sha256: broker.sha256, size: broker.size },
    integrity: {
      algorithm: "sha256",
      manifest: "integrity-manifest.json",
      manifestSha256: sha256(integrityText)
    }
  };
  await writeFile(path.join(root, "package-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { root, paths };
}

describe("packaged subject launch contract", () => {
  it.each(["linux", "win32"] as const)("binds the %s launch to manifest-covered bundle files", async (targetPlatform) => {
    const fixture = await packagedSubject(targetPlatform);
    const subject = await loadPackagedSubjectLaunch(fixture.root, { targetPlatform, targetArch: "x64" });
    expect(subject).toMatchObject({
      nodePath: path.join(fixture.root, ...fixture.paths.node.split("/")),
      cliEntry: path.join(fixture.root, ...fixture.paths.cli.split("/")),
      brokerPath: path.join(fixture.root, ...fixture.paths.broker.split("/")),
      launch: {
        kind: "node",
        runtime: "bundled",
        declaredExecutablePath: path.join(fixture.root, ...fixture.paths.wrapper.split("/")),
        shell: false
      }
    });
    expect(subject.launch.executablePath).not.toBe(process.execPath);
  });

  it("applies the Windows manifest environment and replaces case-conflicting host keys", async () => {
    const fixture = await packagedSubject("win32");
    const subject = await loadPackagedSubjectLaunch(fixture.root, { targetPlatform: "win32", targetArch: "x64" });
    const env = applySubjectLaunchEnvironment({
      Path: "C:\\host-tools",
      node_options: "--require host-shim.cjs",
      SAFE_VALUE: "preserved"
    }, subject.launch);
    expect(env).toMatchObject({
      PATH: `${path.join(fixture.root, "bin")};C:\\host-tools`,
      NODE_OPTIONS: "--preserve-symlinks-main",
      SAFE_VALUE: "preserved"
    });
    expect(env).not.toHaveProperty("Path");
    expect(env).not.toHaveProperty("node_options");
  });

  it("prepends the Linux bundle bin without inventing a runtime environment", async () => {
    const fixture = await packagedSubject("linux");
    const subject = await loadPackagedSubjectLaunch(fixture.root, { targetPlatform: "linux", targetArch: "x64" });
    expect(applySubjectLaunchEnvironment({ PATH: "/usr/bin" }, subject.launch)).toEqual({
      PATH: `${path.join(fixture.root, "bin")}:/usr/bin`
    });
  });

  it("rejects a bundled runtime whose bytes no longer match the manifest", async () => {
    const fixture = await packagedSubject("linux");
    await writeFile(path.join(fixture.root, ...fixture.paths.node.split("/")), "host-node-shim", "utf8");
    await expect(loadPackagedSubjectLaunch(fixture.root, {
      targetPlatform: "linux", targetArch: "x64"
    })).rejects.toThrow(/Node runtime.*integrity manifest/);
  });

  it("requires explicit and distinct development and package runtime descriptors", () => {
    const entryPath = path.resolve("scripts/eval/subject-cli.mjs");
    const devLaunch = createDevNodeLaunch(process.execPath, entryPath);
    expect(subjectNodeLaunch({
      subjectKind: "dev", nodePath: process.execPath, cliEntry: entryPath, launch: devLaunch
    })).toBe(devLaunch);
    expect(() => subjectNodeLaunch({ subjectKind: "dev", nodePath: process.execPath, cliEntry: entryPath }))
      .toThrow(/explicit direct Node launch descriptor/);
    expect(() => subjectNodeLaunch({
      subjectKind: "package",
      nodePath: process.execPath,
      cliEntry: entryPath,
      launch: { ...devLaunch, runtime: "bundled" }
    })).toThrow(/host Node runtime/);
  });

  it.runIf(process.platform === "win32")("compares packaged and host Node paths with Windows semantics", () => {
    const entryPath = path.resolve("scripts/eval/subject-cli.mjs");
    const differentlyCased = `${process.execPath[0]!.toLowerCase()}${process.execPath.slice(1)}`;
    expect(() => subjectNodeLaunch({
      subjectKind: "package",
      nodePath: differentlyCased,
      cliEntry: entryPath,
      launch: {
        ...createDevNodeLaunch(differentlyCased, entryPath),
        runtime: "bundled",
        targetPlatform: "win32"
      }
    })).toThrow(/host Node runtime/);
  });

  it("builds the TUI command only from the explicit subject descriptor", () => {
    const entryPath = path.resolve("scripts/eval/subject-cli.mjs");
    const launch = createDevNodeLaunch(process.execPath, entryPath);
    const subject = { subjectKind: "dev", nodePath: process.execPath, cliEntry: entryPath, launch };
    expect(tuiSubjectCommand(subject, ["tui", "--workspace", "opaque"])).toEqual([
      process.execPath,
      "--experimental-ffi",
      "--disable-warning=ExperimentalWarning",
      entryPath,
      "tui",
      "--workspace",
      "opaque"
    ]);
    expect(() => tuiSubjectCommand({ subjectKind: "dev" }, ["tui"]))
      .toThrow(/explicit direct Node launch descriptor/);
  });

  it("keeps the TUI controller on host PATH while transporting the subject environment separately", () => {
    const controller = tuiControllerEnvironment({
      PATH: "C:\\bundle\\bin;C:\\subject-tools",
      NODE_OPTIONS: "--preserve-symlinks-main",
      DEEPSEEK_API_KEY: "subject-secret"
    }, "C:\\state", { Path: "C:\\host-python", SAFE_HOST: "yes" });
    expect(controller).toMatchObject({
      Path: "C:\\host-python",
      SAFE_HOST: "yes",
      PYTHONUTF8: "1",
      DEEPSEEK_API_KEY: "subject-secret"
    });
    expect(controller).not.toHaveProperty("PATH");
    expect(controller).not.toHaveProperty("NODE_OPTIONS");
    const bridged = JSON.parse(Buffer.from(
      controller.SIGMA_TUI_SUBJECT_ENVIRONMENT_B64!, "base64"
    ).toString("utf8"));
    expect(bridged).toMatchObject({
      PATH: "C:\\bundle\\bin;C:\\subject-tools",
      NODE_OPTIONS: "--preserve-symlinks-main",
      SIGMA_STATE_HOME: "C:\\state"
    });
  });

  it("resolves the TUI controller interpreter from an absolute host PATH entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-host-python-"));
    temporary.push(root);
    const executable = path.join(root, process.platform === "win32" ? "python.exe" : "python3");
    await writeFile(executable, "host-python", "utf8");
    await expect(resolveTuiControllerPython({ PATH: root }, process.platform))
      .resolves.toBe(path.resolve(executable));
  });
});
