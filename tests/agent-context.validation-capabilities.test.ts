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
      availableCommands: ["node"]
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
      stateDigest: "a".repeat(64), availableCommands: ["node"]
    });
    expect(projectCapabilitiesForPath(before, "src/app.mjs")?.unit).toBe(false);

    await mkdir(path.join(root, "tests"));
    const testPath = path.join(root, "tests", "app.test.mjs");
    await writeFile(testPath, "import { test } from 'node:test'; test('ok', () => {});\n", "utf8");
    const added = await deriveRepositoryValidationCapabilities(root, signal, {
      stateDigest: "b".repeat(64), availableCommands: ["node"]
    });
    expect(projectCapabilitiesForPath(added, "src/app.mjs")).toMatchObject({
      unit: true,
      commandFamilies: expect.arrayContaining(["node --test"])
    });

    await rm(testPath);
    const removed = await deriveRepositoryValidationCapabilities(root, signal, {
      stateDigest: "c".repeat(64), availableCommands: ["node"]
    });
    expect(projectCapabilitiesForPath(removed, "src/app.mjs")?.unit).toBe(false);
  });

  it("requires a verified runtime before a manifest test script becomes executable capability", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "node --test" }
    }), "utf8");
    const unavailable = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "a".repeat(64), availableCommands: []
    });
    expect(projectCapabilitiesForPath(unavailable, "src/app.mjs")?.unit).toBe(false);
    const available = await deriveRepositoryValidationCapabilities(root, new AbortController().signal, {
      stateDigest: "b".repeat(64), availableCommands: ["node"]
    });
    expect(projectCapabilitiesForPath(available, "src/app.mjs")?.unit).toBe(true);
  });
});
