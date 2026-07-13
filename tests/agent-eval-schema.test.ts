import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertEvalScenarioV2,
  loadEvalManifestV2,
  parseEvalManifestV2,
  toSubjectDriverSpecV2
} from "../scripts/eval/schema.mjs";

const execFileAsync = promisify(execFile);
const manifestPath = path.resolve("test-fixtures/agent-evals/manifest.json");
const manifestDir = path.dirname(manifestPath);

describe("agent evaluation scenario schema", () => {
  it("loads tiny and repo-scale data-driven scenarios with frozen suite policies", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    expect(manifest.scenarios).toHaveLength(15);
    expect(manifest.scenarios.filter((scenario) => scenario.suites.includes("quick"))).toHaveLength(5);
    expect(manifest.scenarios.filter((scenario) => scenario.suites.includes("experience"))).toHaveLength(12);
    expect(manifest.scenarios.filter((scenario) => scenario.suites.includes("repo-scale"))).toHaveLength(3);
    expect(new Set(manifest.scenarios.map((scenario) => scenario.id)).size).toBe(15);
    expect(manifest.scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      "line-count-readonly",
      "single-file-edit",
      "fix-failing-test",
      "ambiguity-one-question",
      "steer-cleanup",
      "multi-file-change",
      "already-satisfied-noop",
      "tool-failure-recovery",
      "dirty-worktree-preservation",
      "nested-instructions-unicode",
      "large-context-lookup",
      "validation-failure-honesty"
    ]));
  });

  it("keeps fixtures and hidden verifier inputs present but separate", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    for (const scenario of manifest.scenarios) {
      const workspace = path.resolve(manifestDir, scenario.fixture.workspace);
      await expect(access(workspace)).resolves.toBeUndefined();
      await expect(access(path.join(workspace, "verifier.json"))).rejects.toThrow();
      const hiddenVerifier = scenario.verifier.checks.find((check) =>
        check.type === "command" && check.argv.includes("$MANIFEST_DIR/_shared/verify-workspace.mjs"));
      expect(hiddenVerifier).toBeDefined();
      if (hiddenVerifier?.type !== "command") continue;
      for (const argument of hiddenVerifier.argv.filter((entry) => entry.startsWith("$MANIFEST_DIR/"))) {
        await expect(access(path.resolve(manifestDir, argument.slice("$MANIFEST_DIR/".length)))).resolves.toBeUndefined();
      }
    }
  });

  it("projects only subject-visible driving data", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    for (const scenario of manifest.scenarios) {
      const driver = toSubjectDriverSpecV2(scenario);
      expect(Object.keys(driver).sort()).toEqual(["interactions", "messages", "permissions", "surface"]);
      expect(driver).not.toHaveProperty("id");
      expect(driver).not.toHaveProperty("fixture");
      expect(driver).not.toHaveProperty("budget");
      expect(driver).not.toHaveProperty("expectedTerminal");
      expect(driver).not.toHaveProperty("allowedChanges");
      expect(driver).not.toHaveProperty("verifier");
      expect(JSON.stringify(driver)).not.toContain(scenario.id);
    }
  });

  it("freezes repetitions, budgets, schedule seeds, and A/B order at suite level", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    expect(manifest.frozenRunPolicies["repo-scale"]).toEqual({
      schemaVersion: 1,
      seed: 20260714,
      repeat: 3,
      budget: { wallTimeSec: 45, modelTurns: 4, toolCalls: 6, costUsd: 0.03 },
      schedule: "seeded_round_robin",
      abOrder: "interleaved_baseline_first"
    });
  });

  it("declares one deterministic 500-file fixture family for three aggregate tasks", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    const scenarios = manifest.scenarios.filter((scenario) => scenario.suites.includes("repo-scale"));
    expect(scenarios).toHaveLength(3);
    expect(new Set(scenarios.map((scenario) => scenario.repoScale.fixtureFamily))).toEqual(
      new Set(["deterministic-multilang-v1"])
    );
    for (const scenario of scenarios) {
      expect(scenario.repoScale).toMatchObject({ profile: "repo_scale", fileCount: 500, lineCount: 90_000 });
      expect(scenario.fixture.generator).toEqual({ kind: "repo-scale-v1", seed: 20260714, fileCount: 500, lineCount: 90_000 });
      expect(scenario.fixture.setupAfterCommit).toEqual(expect.arrayContaining([
        { type: "link", path: "links/source-alias", target: "src/typescript", linkKind: "directory" },
        { type: "link", path: "links/dangling-alias", target: "missing/directory", linkKind: "directory" }
      ]));
    }
  });

  it("delivers steer only after a real workspace mutation", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    const scenario = manifest.scenarios.find((entry) => entry.id === "steer-cleanup");
    expect(scenario?.interactions).toEqual([
      expect.objectContaining({
        triggers: [
          { kind: "first_mutation" }
        ],
        action: "steer"
      })
    ]);
  });

  it("counts ambiguity interactions from durable events instead of punctuation", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    const scenario = manifest.scenarios.find((entry) => entry.id === "ambiguity-one-question");
    expect(scenario?.verifier.checks).toContainEqual({
      type: "event_count",
      eventType: "tool.requested",
      toolName: "request_user_input",
      minCount: 1,
      maxCount: 1
    });
  });

  it("models a dirty worktree with generic post-commit file operations", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    const scenario = manifest.scenarios.find((entry) => entry.id === "dirty-worktree-preservation");
    expect(scenario?.fixture.setupAfterCommit).toEqual([
      { type: "append", path: "notes.txt", content: "- keep my unfinished local note\n" }
    ]);
    expect(scenario?.verifier.checks).toContainEqual(expect.objectContaining({
      type: "git_diff",
      preserveInitial: true
    }));
  });

  it("accepts every generic interaction action and trigger kind", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    const base = structuredClone(manifest.scenarios[0]);
    expect(() => assertEvalScenarioV2({
      ...base,
      interactions: [
        { triggers: [{ kind: "elapsed_ms", value: 1000 }], action: "submit", text: "initial" },
        { triggers: [{ kind: "event_count", eventType: "tool.requested", count: 2 }], action: "follow_up", text: "more" },
        { triggers: [{ kind: "first_mutation" }], action: "steer", text: "stop" }
      ]
    })).not.toThrow();
  });

  it("rejects identity leaks, path escapes, malformed triggers, and unknown command variables", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    const base = structuredClone(manifest.scenarios[0]);

    expect(() => assertEvalScenarioV2({ ...base, taskId: "hidden" })).toThrow(/unknown field/);
    expect(() => assertEvalScenarioV2({ ...base, budget: "tiny" })).toThrow(/unknown field/);
    expect(() => assertEvalScenarioV2({ ...base, fixture: { workspace: "../outside" } })).toThrow(/must not escape/);
    expect(() => assertEvalScenarioV2({ ...base, fixture: {
      workspace: "fixture",
      setupAfterCommit: [{ type: "link", path: "safe-link", target: "../outside", linkKind: "directory" }]
    } })).toThrow(/must not escape/);
    expect(() => assertEvalScenarioV2({ ...base, fixture: {
      workspace: "fixture",
      setupAfterCommit: [{
        type: "link", path: "safe-link", target: "outside", linkKind: "directory",
        targetScope: "outside_workspace"
      }]
    } })).toThrow(/targetExists is required/);
    expect(() => assertEvalScenarioV2({ ...base, interactions: [{
      triggers: [{ kind: "tool_name", count: 2 }],
      action: "steer",
      text: "stop"
    }] })).toThrow(/elapsed_ms, event_count, first_mutation/);
    expect(() => assertEvalScenarioV2({
      ...base,
      verifier: { checks: [{ type: "command", argv: ["node", "$SCENARIO_ID/verify.mjs"] }] }
    })).toThrow(/unsupported variable/);
    expect(() => assertEvalScenarioV2({ ...base, surface: "cli", permissionPolicy: "allow_once" })).toThrow(/CLI scenarios/);
    expect(() => assertEvalScenarioV2({ ...base, surface: "cli", interactions: [{
      triggers: [{ kind: "elapsed_ms", value: 1 }], action: "follow_up", text: "more"
    }] })).toThrow(/CLI scenarios/);
    expect(() => assertEvalScenarioV2({ ...base, allowedChanges: ["src/[ab].ts"] })).toThrow(/only supports/);
    expect(() => assertEvalScenarioV2({ ...base, allowedChanges: ["src/{client,server}.ts"] })).toThrow(/only supports/);
    expect(() => assertEvalScenarioV2({ ...base, riskClass: "read_only", allowedChanges: ["result.txt"] }))
      .toThrow(/read_only.*allowedChanges/);
    expect(() => assertEvalScenarioV2({
      ...base, riskClass: "read_only", capabilities: [...base.capabilities, "filesystem.write"]
    })).toThrow(/read_only.*write capabilities/);
    for (const capability of ["filesystem-write", "write_file", "workspace.patch", "repository-delete"]) {
      expect(() => assertEvalScenarioV2({
        ...base, riskClass: "read_only", capabilities: [...base.capabilities, capability]
      })).toThrow(/read_only.*write capabilities/);
    }
  });

  it("rejects duplicate ids and invalid answer regular expressions", async () => {
    const manifest = await loadEvalManifestV2(manifestPath);
    expect(() => parseEvalManifestV2({
      schemaVersion: 2,
      frozenRunPolicies: manifest.frozenRunPolicies,
      scenarios: [manifest.scenarios[0], manifest.scenarios[0]]
    })).toThrow(/unique ids/);

    const base = structuredClone(manifest.scenarios[0]);
    expect(() => assertEvalScenarioV2({
      ...base,
      verifier: { checks: [{ type: "answer", pattern: "[" }] }
    })).toThrow(/not a valid regular expression/);
  });

  it("runs the generic hidden Node verifier without mutating a fixture", async () => {
    const workspace = path.resolve(manifestDir, "scenarios/line-count-readonly/workspace");
    const verifier = path.resolve(manifestDir, "_shared/verify-workspace.mjs");
    const spec = path.resolve(manifestDir, "scenarios/line-count-readonly/verifier.json");
    const before = await readFile(path.join(workspace, "src/counter.js"), "utf8");
    const result = await execFileAsync(process.execPath, [verifier, workspace, spec], { windowsHide: true });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, checkedFiles: 4 });
    await expect(readFile(path.join(workspace, "src/counter.js"), "utf8")).resolves.toBe(before);
  });
});
