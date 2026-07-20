import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveRepositoryValidationCapabilities,
  projectCapabilitiesForPath,
  staticValidationClaimsForPath
} from "../packages/agent-context/src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-validation-capabilities-"));
  temporary.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.mjs"), "export const value = 1;\n", "utf8");
  return root;
}

describe("safe repository validation capability profiles", () => {
  it("uses static validation without inventing unit capability for a placeholder package", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "echo \"Error: no test specified\" && exit 1" }
    }), "utf8");
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-validation-outside-"));
    temporary.push(outside);
    await writeFile(path.join(outside, "escape.test.mjs"), "throw new Error('outside');\n", "utf8");
    await symlink(outside, path.join(root, "linked-tests"), process.platform === "win32" ? "junction" : "dir");

    const profile = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "a".repeat(64),
      availableCommands: ["node"],
      availableCommandsComplete: true
    });
    expect(profile.complete).toBe(true);
    expect(projectCapabilitiesForPath(profile, "src/app.mjs")).toMatchObject({
      projectId: ".",
      unit: false,
      staticClaims: ["syntax"]
    });
    expect(staticValidationClaimsForPath(profile, "src/app.mjs")).toEqual(["syntax"]);
    expect(profile.projects.flatMap((project) => project.evidence)).not.toContain("linked-tests/escape.test.mjs");
  });

  it("refreshes structural unit capability when a real test entry is added or removed", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    const signal = new AbortController().signal;
    const before = await deriveRepositoryValidationCapabilities(root, signal, {
      stateDigest: "a".repeat(64), availableCommands: ["node"], availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(before, "src/app.mjs")?.unit).toBe(false);

    await mkdir(path.join(root, "tests"));
    const testPath = path.join(root, "tests", "app.test.mjs");
    await writeFile(testPath, "import { test } from 'node:test'; test('ok', () => {});\n", "utf8");
    const added = await deriveRepositoryValidationCapabilities(root, signal, {
      stateDigest: "b".repeat(64), availableCommands: ["node"], availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(added, "src/app.mjs")).toMatchObject({
      unit: true,
      commandFamilies: expect.arrayContaining(["node --test"])
    });

    await rm(testPath);
    const removed = await deriveRepositoryValidationCapabilities(root, signal, {
      stateDigest: "c".repeat(64), availableCommands: ["node"], availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(removed, "src/app.mjs")?.unit).toBe(false);
  });

  it("requires a verified runtime before a manifest test script becomes executable capability", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "node --test" }
    }), "utf8");
    const unavailable = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "a".repeat(64), availableCommands: [], availableCommandsComplete: true
    });
    expect(unavailable.complete).toBe(true);
    expect(unavailable.availableCommandsComplete).toBe(true);
    expect(projectCapabilitiesForPath(unavailable, "src/app.mjs")?.unit).toBe(false);
    const available = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "b".repeat(64), availableCommands: ["node"], availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(available, "src/app.mjs")?.unit).toBe(true);

    const unknown = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "c".repeat(64), availableCommands: []
    });
    expect(unknown.complete).toBe(false);
    expect(unknown.availableCommandsComplete).toBe(false);
  });

  it("keeps the profile incomplete when a discovered manifest cannot be read completely", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "package.json"), " ".repeat(256_001), "utf8");

    const profile = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "d".repeat(64), availableCommands: [], availableCommandsComplete: true
    });

    expect(profile.complete).toBe(false);
    expect(profile.availableCommandsComplete).toBe(true);
  });

  it("treats workspace build wrappers as possible validation capabilities", async () => {
    const root = await workspace();
    await Promise.all([
      writeFile(path.join(root, "pom.xml"), "<project/>", "utf8"),
      writeFile(path.join(root, "mvnw"), "#!/bin/sh\n", "utf8"),
      mkdir(path.join(root, "tests"))
    ]);
    await writeFile(path.join(root, "tests", "AppTest.java"), "class AppTest {}\n", "utf8");

    const maven = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "e".repeat(64), availableCommands: [], availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(maven, "tests/AppTest.java")).toMatchObject({
      unit: true,
      commandFamilies: expect.arrayContaining(["maven build/check", "maven test"]),
      evidence: expect.arrayContaining(["pom.xml", "mvnw"])
    });

    await Promise.all([
      writeFile(path.join(root, "build.gradle"), "plugins {}\n", "utf8"),
      writeFile(path.join(root, "gradlew"), "#!/bin/sh\n", "utf8"),
      rm(path.join(root, "tests"), { recursive: true, force: true })
    ]);
    const gradle = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "f".repeat(64), availableCommands: [], availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(gradle, "src/app.mjs")).toMatchObject({
      unit: false,
      commandFamilies: expect.arrayContaining(["gradle build/check"]),
      evidence: expect.arrayContaining(["build.gradle", "gradlew"])
    });
  });

  it("discovers generic native and static-site build manifests", async () => {
    const root = await workspace();
    await Promise.all([
      writeFile(path.join(root, "Makefile"), "all:\n\t@true\n", "utf8"),
      writeFile(path.join(root, "CMakeLists.txt"), "project(example)\n", "utf8"),
      writeFile(path.join(root, "Gemfile"), "gem 'jekyll'\n", "utf8"),
      writeFile(path.join(root, "_config.yml"), "title: example\n", "utf8")
    ]);

    const profile = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "1".repeat(64),
      availableCommands: ["make", "cmake", "bundle"],
      availableCommandsComplete: true
    });

    expect(projectCapabilitiesForPath(profile, "README.md")).toMatchObject({
      commandFamilies: expect.arrayContaining(["make build/check", "cmake build/check", "jekyll build"]),
      evidence: expect.arrayContaining(["Makefile", "CMakeLists.txt", "Gemfile", "_config.yml"])
    });
  });

  it("discovers package-manager build scripts only when a package manager is available", async () => {
    const root = await workspace();
    await Promise.all([
      writeFile(path.join(root, "index.html"), "<!doctype html>\n", "utf8"),
      writeFile(path.join(root, "package.json"), JSON.stringify({
        scripts: { build: "vite build", verify: "astro check" }
      }), "utf8")
    ]);

    const unavailable = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "2".repeat(64),
      availableCommands: ["node"],
      availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(unavailable, "index.html")?.commandFamilies)
      .not.toContain("package-manager build");

    const available = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "3".repeat(64),
      availableCommands: ["node", "npm"],
      availableCommandsComplete: true
    });
    expect(projectCapabilitiesForPath(available, "index.html")).toMatchObject({
      commandFamilies: expect.arrayContaining(["package-manager build", "package-manager verify"]),
      evidence: expect.arrayContaining(["package.json#scripts.build", "package.json#scripts.verify"])
    });
  });
});
