import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  integerFactsFromAnswer,
  runPostVerifier,
  verifierNodeToolchain,
  verifierSandboxPolicy
} from "../scripts/eval/verifier.mjs";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent evaluation verifier isolation", () => {
  it("recognizes standalone integer facts across common grouping separators", () => {
    expect(integerFactsFromAnswer("440\n79,200 79.200 79\u00a0200 79\u202f200")).toEqual([
      440, 79_200, 79_200, 79_200, 79_200
    ]);
    expect(integerFactsFromAnswer("4400 and 12.34 and x440")).not.toContain(440);
  });

  it("keeps copied workspace evidence read-only and isolates verifier writes", () => {
    const workspace = path.resolve("controller", "verifier-workspace");
    const manifestDir = path.resolve("controller", "verifier-manifest");
    const home = path.resolve("controller", "verifier-home");
    const nodePath = path.resolve("portable", "bin", "node.exe");

    expect(verifierSandboxPolicy({ workspace, manifestDir, home }, nodePath)).toEqual({
      sandbox: "required",
      network: "none",
      readRoots: [workspace, manifestDir, path.dirname(nodePath), path.dirname(home)],
      writeRoots: [home]
    });
  });

  it("binds command verification to one exact Node toolchain", () => {
    const nodePath = path.resolve("portable", "bin", "node.exe");
    const compatibility = { kind: "test-proof", executableSha256: "a".repeat(64) };
    const createProof = (executable: string, id: string) => {
      expect(executable).toBe(nodePath);
      expect(id).toBe("eval-verifier-node");
      return compatibility;
    };
    expect(verifierNodeToolchain(nodePath, {
      WINDOWS_APPCONTAINER_NODE_COMPATIBILITY: {
        requiredNodeOptions: "--preserve-symlinks --preserve-symlinks-main"
      },
      createWindowsAppContainerNodeCompatibilityProof: createProof
    }, "win32")).toEqual({
      id: "eval-verifier-node",
      runtime: "node",
      executable: nodePath,
      aliases: ["node", "node.exe"],
      executionRoots: [nodePath],
      pathEntries: [],
      environment: { NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" },
      compatibility
    });
  });

  it("does not follow a subject-created symlink or junction outside the verifier workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-verifier-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const artifactDir = path.join(root, "artifacts");
    await Promise.all([mkdir(workspace), mkdir(outside), mkdir(artifactDir)]);
    await writeFile(path.join(outside, "value.txt"), "outside secret\n", "utf8");
    await symlink(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");

    const result = await runPostVerifier({
      scenario: {
        expectedTerminal: "completed",
        verifier: { checks: [{ type: "file", path: "escape/value.txt", equals: "outside secret\n" }] }
      },
      workspace,
      manifestDir: root,
      delta: { added: [], modified: [], deleted: [] },
      initialGit: { status: "", diff: "" },
      finalGit: { status: "", diff: "" },
      subjectResult: { result: { status: "completed" } },
      events: [],
      metrics: { terminal: { type: "run.completed" } },
      artifactDir,
      redactor: String
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0]).toMatchObject({ type: "file", passed: false });
    expect(result.checks[0].message).toMatch(/symbolic link|junction/iu);
  });

  it("keeps completed-with-limitations verifier-reachable while preserving the public result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-limited-completion-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const artifactDir = path.join(root, "artifacts");
    await Promise.all([mkdir(workspace), mkdir(artifactDir)]);
    const result = await runPostVerifier({
      scenario: { expectedTerminal: "completed", verifier: { checks: [] } },
      workspace,
      manifestDir: root,
      delta: { added: [], modified: [], deleted: [] },
      initialGit: { status: "", diff: "" },
      finalGit: { status: "", diff: "" },
      subjectResult: {
        result: {
          status: "completed_with_limitations",
          finishReason: "completed_with_limitations",
          finalMessage: "Artifact produced with a declared validation limitation."
        }
      },
      events: [],
      metrics: { terminal: { type: "run.completed" } },
      artifactDir,
      redactor: String
    });

    expect(result.delivery.status).toBe("pass");
    expect(result.terminal).toMatchObject({ expected: "completed", actual: "completed" });
    expect(result.finalAnswer).toContain("declared validation limitation");
  });

  it("verifies one user interruption by event count even when the message has multiple question marks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-event-check-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const artifactDir = path.join(root, "artifacts");
    await Promise.all([mkdir(workspace), mkdir(artifactDir)]);
    const result = await runPostVerifier({
      scenario: {
        expectedTerminal: "needs_input",
        verifier: { checks: [{
          type: "event_count",
          eventType: "tool.requested",
          toolName: "request_user_input",
          minCount: 1,
          maxCount: 1
        }] }
      },
      workspace,
      manifestDir: root,
      delta: { added: [], modified: [], deleted: [] },
      initialGit: { status: "", diff: "" },
      finalGit: { status: "", diff: "" },
      subjectResult: { result: { status: "needs_input", finalMessage: "request timeout？idle timeout？" } },
      events: [{ type: "tool.requested", payload: { name: "request_user_input" } }],
      metrics: { terminal: { type: "run.suspended" } },
      artifactDir,
      redactor: String
    });

    expect(result.status).toBe("pass");
    expect(result.checks[0]).toMatchObject({ type: "event_count", passed: true, count: 1 });
  });

  it("passes only the expected recoverable failure code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-expected-error-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const artifactDir = path.join(root, "artifacts");
    await Promise.all([mkdir(workspace), mkdir(artifactDir)]);
    const context = {
      scenario: {
        expectedTerminal: "error",
        expectedFailureCode: "validation_failed",
        verifier: { checks: [{ type: "answer", numericValues: [440, 79_200] }] }
      },
      workspace,
      manifestDir: root,
      delta: { added: [], modified: [], deleted: [] },
      initialGit: { status: "", diff: "" },
      finalGit: { status: "", diff: "" },
      events: [],
      artifactDir,
      redactor: String
    };
    const matching = await runPostVerifier({
      ...context,
      subjectResult: { result: { status: "error", finalMessage: "440 files\n79,200 lines" } },
      metrics: { terminal: { type: "run.failed", code: "validation_failed" } }
    });
    expect(matching.status).toBe("pass");
    expect(matching.delivery.status).toBe("pass");
    expect(matching.terminal).toEqual({
      expected: "error",
      actual: "error",
      expectedCode: "validation_failed",
      actualCode: "validation_failed"
    });

    const wrongCode = await runPostVerifier({
      ...context,
      subjectResult: { result: { status: "error", finalMessage: "440 files\n79.200 lines" } },
      metrics: { terminal: { type: "run.failed", code: "reported_blocker" } }
    });
    expect(wrongCode.delivery.status).toBe("fail");
  });
});
