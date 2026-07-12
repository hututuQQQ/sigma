import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertEvalScenarioV1,
  EVAL_BUDGETS_V1,
  loadEvalManifestV1,
  parseEvalManifestV1,
  toSubjectDriverSpecV1
} from "../scripts/eval/schema.mjs";

const execFileAsync = promisify(execFile);
const manifestPath = path.resolve("test-fixtures/agent-evals/manifest.json");
const manifestDir = path.dirname(manifestPath);

describe("agent evaluation scenario schema", () => {
  it("loads twelve data-driven scenarios with the intended suite split", async () => {
    const manifest = await loadEvalManifestV1(manifestPath);
    expect(manifest.scenarios).toHaveLength(12);
    expect(manifest.scenarios.filter((scenario) => scenario.suites.includes("quick"))).toHaveLength(5);
    expect(manifest.scenarios.filter((scenario) => scenario.suites.includes("experience"))).toHaveLength(12);
    expect(new Set(manifest.scenarios.map((scenario) => scenario.id)).size).toBe(12);
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
    const manifest = await loadEvalManifestV1(manifestPath);
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
    const manifest = await loadEvalManifestV1(manifestPath);
    for (const scenario of manifest.scenarios) {
      const driver = toSubjectDriverSpecV1(scenario);
      expect(Object.keys(driver).sort()).toEqual(["interactions", "permissionPolicy", "surface", "userMessages"]);
      expect(driver).not.toHaveProperty("id");
      expect(driver).not.toHaveProperty("fixture");
      expect(driver).not.toHaveProperty("budget");
      expect(driver).not.toHaveProperty("expectedTerminal");
      expect(driver).not.toHaveProperty("allowedChanges");
      expect(driver).not.toHaveProperty("verifier");
    }
  });

  it("defines the requested external stop-loss budgets", () => {
    expect(EVAL_BUDGETS_V1).toEqual({
      tiny: { wallTimeSec: 120, modelTurns: 8, toolCalls: 12, costUsd: 0.1 },
      small: { wallTimeSec: 300, modelTurns: 16, toolCalls: 30, costUsd: 0.25 },
      medium: { wallTimeSec: 600, modelTurns: 40, toolCalls: 120, costUsd: 0.8 },
      complex: { wallTimeSec: 900, modelTurns: 80, toolCalls: 250, costUsd: 1.5 }
    });
  });

  it("delivers steer only after a real workspace mutation", async () => {
    const manifest = await loadEvalManifestV1(manifestPath);
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
    const manifest = await loadEvalManifestV1(manifestPath);
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
    const manifest = await loadEvalManifestV1(manifestPath);
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
    const manifest = await loadEvalManifestV1(manifestPath);
    const base = structuredClone(manifest.scenarios[0]);
    expect(() => assertEvalScenarioV1({
      ...base,
      interactions: [
        { triggers: [{ kind: "elapsed_ms", value: 1000 }], action: "submit", text: "initial" },
        { triggers: [{ kind: "event_count", eventType: "tool.requested", count: 2 }], action: "follow_up", text: "more" },
        { triggers: [{ kind: "first_mutation" }], action: "steer", text: "stop" }
      ]
    })).not.toThrow();
  });

  it("rejects identity leaks, path escapes, malformed triggers, and unknown command variables", async () => {
    const manifest = await loadEvalManifestV1(manifestPath);
    const base = structuredClone(manifest.scenarios[0]);

    expect(() => assertEvalScenarioV1({ ...base, taskId: "hidden" })).toThrow(/unknown field/);
    expect(() => assertEvalScenarioV1({ ...base, fixture: { workspace: "../outside" } })).toThrow(/must not escape/);
    expect(() => assertEvalScenarioV1({ ...base, interactions: [{
      triggers: [{ kind: "tool_name", count: 2 }],
      action: "steer",
      text: "stop"
    }] })).toThrow(/elapsed_ms, event_count, first_mutation/);
    expect(() => assertEvalScenarioV1({
      ...base,
      verifier: { checks: [{ type: "command", argv: ["node", "$SCENARIO_ID/verify.mjs"] }] }
    })).toThrow(/unsupported variable/);
    expect(() => assertEvalScenarioV1({ ...base, surface: "cli", permissionPolicy: "allow_once" })).toThrow(/CLI scenarios/);
    expect(() => assertEvalScenarioV1({ ...base, surface: "cli", interactions: [{
      triggers: [{ kind: "elapsed_ms", value: 1 }], action: "follow_up", text: "more"
    }] })).toThrow(/CLI scenarios/);
    expect(() => assertEvalScenarioV1({ ...base, allowedChanges: ["src/[ab].ts"] })).toThrow(/only supports/);
    expect(() => assertEvalScenarioV1({ ...base, allowedChanges: ["src/{client,server}.ts"] })).toThrow(/only supports/);
  });

  it("rejects duplicate ids and invalid answer regular expressions", async () => {
    const manifest = await loadEvalManifestV1(manifestPath);
    expect(() => parseEvalManifestV1({
      schemaVersion: 1,
      scenarios: [manifest.scenarios[0], manifest.scenarios[0]]
    })).toThrow(/unique ids/);

    const base = structuredClone(manifest.scenarios[0]);
    expect(() => assertEvalScenarioV1({
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
