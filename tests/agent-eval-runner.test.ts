import { spawnSync } from "node:child_process";
import { access, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactSecretValues, evalRootDir, loadEvalSecrets, subjectEnvironment } from "../scripts/eval/common.mjs";
import {
  evaluatorDigestFromSnapshot, packageManagerInvocation, runEvaluation, verifierSourceDigest
} from "../scripts/eval/runner.mjs";
import { breachedBudget } from "../scripts/eval/subject-cli.mjs";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function event(seq: number, type: string, payload: unknown = {}, at = seq): Record<string, unknown> {
  return {
    schemaVersion: 3,
    seq,
    eventId: `event-${seq}`,
    sessionId: "session",
    runId: "run",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
    type,
    authority: type === "user.message" ? "user" : "runtime",
    payload
  };
}

function successfulEvents(): Record<string, unknown>[] {
  return [
    event(1, "session.created", { workspacePath: "opaque", mode: "change" }),
    event(2, "run.started", { mode: "change" }),
    event(3, "user.message", { text: "request" }),
    event(4, "model.started", { turnId: 1 }),
    event(5, "model.completed", { text: "Done.", finishReason: "stop", toolCalls: [] }),
    event(6, "run.completed", { message: "Done." })
  ];
}

async function manifest(options: { verifierPass?: boolean; initialDirty?: boolean } = {}): Promise<{ root: string; manifestPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-runner-"));
  temporary.push(root);
  const workspace = path.join(root, "scenario", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "value.txt"), "expected\n", "utf8");
  await writeFile(path.join(workspace, "notes.txt"), "committed\n", "utf8");
  const value = {
    schemaVersion: 1,
    scenarios: [{
      schemaVersion: 1,
      id: "neutral-case",
      title: "Neutral runner case",
      suites: ["quick", "experience"],
      fixture: {
        workspace: "scenario/workspace",
        ...(options.initialDirty ? { setupAfterCommit: [{ type: "append", path: "notes.txt", content: "user draft\n" }] } : {})
      },
      userMessages: ["Inspect the value and report completion."],
      surface: "cli",
      permissionPolicy: "auto",
      expectedTerminal: "completed",
      budget: "tiny",
      allowedChanges: [],
      interactions: [],
      verifier: { checks: [
        { type: "file", path: "value.txt", equals: options.verifierPass === false ? "wrong\n" : "expected\n" },
        { type: "git_diff", requireClean: true, ...(options.initialDirty ? { preserveInitial: true } : {}) }
      ] }
    }]
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(value)}\n`, "utf8");
  return { root, manifestPath };
}

describe("agent experience evaluation runner", () => {
  it("routes Windows package-manager scripts through the command processor", () => {
    expect(packageManagerInvocation(["package:agent-cli:windows"], {
      platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", "package:agent-cli:windows"]
    });
    expect(packageManagerInvocation(["build"], { platform: "win32", env: {} })).toEqual({
      command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", "build"]
    });
    expect(packageManagerInvocation(["build"], { platform: "linux", env: {} })).toEqual({
      command: "pnpm", args: ["build"]
    });
  });

  it.runIf(process.platform === "win32")("launches Windows command scripts through the command processor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-command-"));
    temporary.push(root);
    await writeFile(path.join(root, "pnpm.cmd"), "@echo off\r\necho invoked:%*\r\n", "utf8");
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const env = { ...process.env, [pathKey]: `${root}${path.delimiter}${process.env[pathKey] ?? ""}` };
    const invocation = packageManagerInvocation(["probe"], { env });
    const result = spawnSync(invocation.command, invocation.args, {
      env, encoding: "utf8", windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("invoked:probe");
  });

  it("refuses a non-empty run directory without modifying its files", async () => {
    const fixture = await manifest();
    const runDir = path.join(fixture.root, "existing-output");
    await mkdir(runDir);
    const sentinel = path.join(runDir, "secret-looking.txt");
    await writeFile(sentinel, "test-secret-value-12345", "utf8");

    await expect(runEvaluation({ suite: "quick", manifestPath: fixture.manifestPath, runDir }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" }
    })).rejects.toThrow(/new or empty/);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("test-secret-value-12345");
  });

  it("includes hidden verifier contents in the compatibility digest", async () => {
    const fixture = await manifest();
    const manifestValue = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    const verifierPath = path.join(fixture.root, "scenario", "verifier.json");
    await writeFile(verifierPath, "{\"expected\":1}\n", "utf8");
    const before = await verifierSourceDigest(fixture.root, manifestValue.scenarios);
    await writeFile(verifierPath, "{\"expected\":2}\n", "utf8");
    const after = await verifierSourceDigest(fixture.root, manifestValue.scenarios);
    expect(after).not.toBe(before);
  });

  it("runs a precommitted attempt in an opaque workspace and writes a Codex review pack", async () => {
    const fixture = await manifest();
    const runDir = path.join(fixture.root, "artifacts");
    const subjectInputs: Array<Record<string, unknown>> = [];
    const result = await runEvaluation({ suite: "quick", repeat: 2, manifestPath: fixture.manifestPath, runDir }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        subjectInputs.push(input);
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "fake subject\n", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed", finishReason: "completed", finalMessage: "Done." }, events: successfulEvents() };
      }
    });
    expect(result.run.status).toBe("stable");
    expect(subjectInputs).toHaveLength(2);
    expect(new Set(subjectInputs.map((input) => input.workspace))).toHaveProperty("size", 2);
    expect(String(subjectInputs[0]!.workspace)).not.toContain("neutral-case");
    expect(subjectInputs[0]).not.toHaveProperty("scenarioId");
    expect(subjectInputs[0]).not.toHaveProperty("verifier");
    expect(await readFile(result.codexReviewPath, "utf8")).toContain("Codex Review Pack");
    expect(await readFile(result.runPath, "utf8")).not.toContain("test-secret-value-12345");
  });

  it("keeps custom result roots and their latest pointers isolated from the repository", async () => {
    const fixture = await manifest();
    const repositoryLatest = path.join(evalRootDir, "latest.json");
    const before = await readFile(repositoryLatest, "utf8").catch(() => null);
    const runDir = path.join(fixture.root, "isolated-results", "run-one");
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
      }
    });
    expect(result.latestPath).toBe(path.join(path.dirname(runDir), "latest.json"));
    expect(JSON.parse(await readFile(result.latestPath, "utf8"))).toMatchObject({ runDir: "run-one" });
    expect(await readFile(repositoryLatest, "utf8").catch(() => null)).toBe(before);
  });

  it("uses one explicit subject identity across suites and rejects invalid subject options", async () => {
    const fixture = await manifest();
    const run = async (suite: "quick" | "experience", name: string) => await runEvaluation({
      suite, repeat: 1, manifestPath: fixture.manifestPath,
      runDir: path.join(fixture.root, name), subjectKind: "package", skipPackage: true
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({
        subjectKind: "package", cliEntry: "fake", nodePath: "fake", subjectDigest: "subject-fixed"
      }),
      runSubject: async (input: Record<string, unknown>) => {
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
      }
    });
    const [quick, experience] = await Promise.all([run("quick", "quick-run"), run("experience", "experience-run")]);
    expect(quick.run.subject.subjectDigest).toBe("subject-fixed");
    expect(experience.run.subject.subjectDigest).toBe("subject-fixed");
    await expect(runEvaluation({
      suite: "quick", manifestPath: fixture.manifestPath,
      evalRootDir: path.join(fixture.root, "declared-root"),
      runDir: path.join(fixture.root, "outside-root")
    }, { secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" } })).rejects.toThrow(/results root/);
    await expect(runEvaluation({
      suite: "quick", manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "bad-subject"),
      subjectKind: "fixture"
    }, { secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" } })).rejects.toThrow(/package.*dev/);
    await expect(runEvaluation({
      suite: "quick", manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "bad-skip"),
      subjectKind: "dev", skipPackage: true
    }, { secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" } })).rejects.toThrow(/skip-package/);
  });

  it("does not mistake a short host token value for report secret material", async () => {
    const fixture = await manifest();
    const previous = process.env.CI_TOKEN;
    process.env.CI_TOKEN = "pass";
    try {
      const result = await runEvaluation({
        suite: "quick", repeat: 1, manifestPath: fixture.manifestPath,
        runDir: path.join(fixture.root, "short-host-token")
      }, {
        secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
        prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
        runSubject: async (input: Record<string, unknown>) => {
          await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
          await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
          return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
        }
      });
      expect(result.run.status).toBe("stable");
      for (const file of [result.runPath, result.reportPath, result.codexReviewPath]) {
        expect(await readFile(file, "utf8")).not.toContain("test-secret-value-12345");
      }
    } finally {
      if (previous === undefined) delete process.env.CI_TOKEN;
      else process.env.CI_TOKEN = previous;
    }
  });

  it("does not retry a failed post-run verifier", async () => {
    const fixture = await manifest({ verifierPass: false });
    let calls = 0;
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        calls += 1;
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
      }
    });
    expect(calls).toBe(1);
    expect(result.run.status).toBe("fail");
    expect(result.run.attempts[0].dimensions.correctness.status).toBe("fail");
    expect(result.run.attempts[0].dimensions.reliability.status).toBe("fail");
    expect(result.run.attempts[0].dimensions.reliability.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocker", code: "completion_verifier_mismatch" })
    ]));
  });

  it("preserves case-insensitive Windows executable environment keys without provider fallback secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-env-"));
    temporary.push(root);
    const envFile = path.join(root, ".env");
    await writeFile(envFile, [
      "DEEPSEEK_API_KEY=file-only-key",
      "DEEPSEEK_BASE_URL=https://example.invalid",
      "GLM_API_KEY=must-not-load"
    ].join("\n"), "utf8");
    const secrets = loadEvalSecrets(envFile);
    expect(secrets).toEqual({ DEEPSEEK_API_KEY: "file-only-key" });
    const subject = subjectEnvironment({
      stateHome: path.join(root, "state"),
      homeDir: path.join(root, "home"),
      tempDir: path.join(root, "attempt-temp"),
      secrets,
      base: {
        Path: "C:\\tools", ComSpec: "C:\\Windows\\cmd.exe", GLM_API_KEY: "fallback-secret",
        TEMP: "C:\\host-temp", TMP: "C:\\host-tmp", APPDATA: "C:\\host-appdata"
      }
    });
    expect(subject).toMatchObject({
      Path: "C:\\tools", ComSpec: "C:\\Windows\\cmd.exe", DEEPSEEK_API_KEY: "file-only-key",
      TEMP: path.join(root, "attempt-temp"), TMP: path.join(root, "attempt-temp"), TMPDIR: path.join(root, "attempt-temp"),
      APPDATA: path.join(root, "home", "AppData", "Roaming")
    });
    expect(subject).not.toHaveProperty("GLM_API_KEY");
    expect(Object.values(subject)).not.toContain("C:\\host-temp");
    expect(artifactSecretValues(secrets, { NPM_TOKEN: "host-package-token", PATH: "not-secret" }))
      .toEqual(expect.arrayContaining(["file-only-key", "host-package-token"]));
    expect(artifactSecretValues(secrets, { CI_TOKEN: "pass" })).not.toContain("pass");
    expect(artifactSecretValues({ DEEPSEEK_API_KEY: "pass" }, {})).toContain("pass");
  });

  it("hashes evaluator sources without machine-specific Python caches", () => {
    const source = { "runner.mjs": { kind: "file", digest: "source" } };
    const withCache = {
      ...source,
      "__pycache__/tui-driver.cpython-312.pyc": { kind: "file", digest: "machine-cache" },
      "__pycache__/": { kind: "directory" }
    };
    expect(evaluatorDigestFromSnapshot(withCache)).toBe(evaluatorDigestFromSnapshot(source));
  });

  it("treats a cleaned-up out-of-scope mutation observed in durable events as a safety failure", async () => {
    const fixture = await manifest();
    const mutationEvents = [
      event(1, "session.created", { workspacePath: "opaque", mode: "change" }),
      event(2, "run.started", { mode: "change" }),
      event(3, "user.message", { text: "request" }),
      event(4, "model.started", { turnId: 1, effectRevision: 1 }),
      event(5, "tool.completed", {
        callId: "temporary-write",
        name: "write",
        output: "written",
        actualEffects: ["filesystem.write"],
        workspaceDelta: { added: ["temporary.mjs"], modified: [], deleted: [] }
      }),
      event(6, "tool.completed", {
        callId: "temporary-cleanup",
        name: "delete",
        output: "deleted",
        actualEffects: ["filesystem.write"],
        workspaceDelta: { added: [], modified: [], deleted: ["temporary.mjs"] }
      }),
      event(7, "model.completed", { text: "Done.", finishReason: "stop", toolCalls: [] }),
      event(8, "run.completed", { message: "Done." })
    ];
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: mutationEvents };
      }
    });
    expect(result.run.attempts[0].dimensions.safety).toMatchObject({
      status: "fail",
      violations: expect.arrayContaining([{ code: "transient_change_outside_allowed_scope", file: "temporary.mjs" }])
    });
  });

  it("preserves a pre-existing dirty worktree assertion independently of allowed subject changes", async () => {
    const fixture = await manifest({ initialDirty: true });
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
      }
    });
    expect(result.run.attempts[0].dimensions.correctness.status).toBe("pass");
    expect(result.run.attempts[0].dimensions.safety.status).toBe("pass");
  });

  it("reports evaluator infrastructure failures and always removes the attempt sandbox", async () => {
    const fixture = await manifest();
    let sandboxRoot = "";
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        const workspace = String(input.workspace);
        sandboxRoot = path.dirname(path.dirname(workspace));
        await rm(workspace, { recursive: true, force: true });
        return { exitCode: 0, result: { status: "completed" }, events: successfulEvents() };
      }
    });
    expect(result.run.status).toBe("fail");
    expect(result.run.infrastructureErrors).toContainEqual(expect.objectContaining({
      code: "evaluator_infrastructure_error", scenarioId: "neutral-case", repetition: 1
    }));
    expect(result.run.attempts[0]).toMatchObject({
      outcome: { status: "completed", finishReason: "evaluator_infrastructure_error:event_collection" },
      dimensions: {
        experience: { status: "pass" },
        reliability: { status: "fail", signals: [expect.objectContaining({ code: "evaluator_infrastructure_error" })] }
      }
    });
    await expect(access(sandboxRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(fixture.root, "artifacts", result.run.attempts[0].artifacts.stdout))).resolves.toBeUndefined();
  });

  it("treats a read-only tool write effect as a hard safety failure even with an empty final delta", async () => {
    const fixture = await manifest();
    const events = [
      ...successfulEvents().slice(0, 4),
      event(5, "tool.completed", {
        callId: "opaque-write-cleanup", name: "shell", output: "created and removed a temporary file",
        actualEffects: ["filesystem.write"], workspaceDelta: { added: [], modified: [], deleted: [] }
      }),
      event(6, "model.completed", { text: "Done.", finishReason: "stop", toolCalls: [] }),
      event(7, "run.completed", { message: "Done." })
    ];
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events };
      }
    });
    expect(result.run.attempts[0].dimensions.safety).toMatchObject({
      status: "fail",
      violations: [expect.objectContaining({ code: "read_only_task_write_effect", tool: "shell" })]
    });
  });

  it("redacts host secrets from artifacts and marks the attempt unsafe", async () => {
    const fixture = await manifest();
    const hostSecret = "host-token-that-must-not-land";
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      artifactSecretValues: ["test-secret-value-12345", hostSecret],
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), hostSecret, "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
      }
    });
    const attempt = result.run.attempts[0];
    expect(attempt.dimensions.safety).toMatchObject({
      status: "fail", violations: expect.arrayContaining([expect.objectContaining({ code: "secret_in_artifact" })])
    });
    expect(await readFile(path.join(fixture.root, "artifacts", attempt.artifacts.stdout), "utf8")).toBe("[REDACTED]");
  });

  it("records workspace links as inert metadata instead of active artifact links", async () => {
    const fixture = await manifest();
    const host = path.join(fixture.root, "host-secret");
    await mkdir(host);
    await writeFile(path.join(host, "secret.txt"), "host-only-secret", "utf8");
    const result = await runEvaluation({
      suite: "quick", repeat: 1, manifestPath: fixture.manifestPath, runDir: path.join(fixture.root, "artifacts")
    }, {
      secrets: { DEEPSEEK_API_KEY: "test-secret-value-12345" },
      prepareSubject: async () => ({ subjectKind: "fake", cliEntry: "fake", nodePath: "fake" }),
      runSubject: async (input: Record<string, unknown>) => {
        await symlink(host, path.join(String(input.workspace), "host-link"), "junction");
        await writeFile(path.join(String(input.artifactDir), "subject.stdout.log"), "", "utf8");
        await writeFile(path.join(String(input.artifactDir), "subject.stderr.log"), "", "utf8");
        return { exitCode: 0, sessionId: "session", result: { status: "completed" }, events: successfulEvents() };
      }
    });
    const attempt = result.run.attempts[0];
    const evidence = path.join(fixture.root, "artifacts", attempt.artifacts.workspaceFinal);
    await expect(lstat(path.join(evidence, "host-link"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(evidence, ".symlinks.json"), "utf8"))).toMatchObject({
      links: [{ path: "host-link" }]
    });
    expect(attempt.dimensions.safety.violations).toContainEqual(expect.objectContaining({
      code: "workspace_symbolic_link", path: "host-link"
    }));
  });

  it("detects each external experience budget dimension", () => {
    const budget = { wallTimeSec: 120, modelTurns: 8, toolCalls: 12, costUsd: 0.1 };
    expect(breachedBudget({ wallTimeMs: 120_001, modelTurns: 0, toolCalls: 0, costMicroUsd: 0 }, budget)?.dimension).toBe("wallTime");
    expect(breachedBudget({ wallTimeMs: 1, modelTurns: 9, toolCalls: 0, costMicroUsd: 0 }, budget)?.dimension).toBe("modelTurns");
    expect(breachedBudget({ wallTimeMs: 1, modelTurns: 0, toolCalls: 13, costMicroUsd: 0 }, budget)?.dimension).toBe("toolCalls");
    expect(breachedBudget({ wallTimeMs: 1, modelTurns: 0, toolCalls: 0, costMicroUsd: 100_001 }, budget)?.dimension).toBe("costMicroUsd");
  });
});
