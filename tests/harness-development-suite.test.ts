import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEvalProviderAccess } from "../scripts/eval/common.mjs";
import {
  HARNESS_DEVELOPMENT_BINDING,
  runHarnessDevelopmentCli
} from "../scripts/eval/harness-development.mjs";
import manifest from "../test-fixtures/agent-evals/manifest.json" with { type: "json" };

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("flagship Harness development suite", () => {
  it("binds a representative non-benchmark suite to Sol max with three repetitions", () => {
    const selected = manifest.scenarios
      .filter((scenario) => scenario.suites.includes(HARNESS_DEVELOPMENT_BINDING.suite))
      .map((scenario) => scenario.id);
    expect(selected).toEqual(HARNESS_DEVELOPMENT_BINDING.scenarios);
    expect(manifest.frozenRunPolicies[HARNESS_DEVELOPMENT_BINDING.suite]).toMatchObject({
      repeat: 3,
      schedule: "seeded_round_robin",
      abOrder: "interleaved_baseline_first"
    });
    expect(HARNESS_DEVELOPMENT_BINDING).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      repeat: 3
    });
    expect(JSON.stringify({ selected, manifest })).not.toMatch(
      /terminal-bench|tb2(?:\.1)?|verifier feedback/iu
    );
  });

  it("rejects result-directed control overrides and appends only frozen controls", async () => {
    const runner = vi.fn(async (argv: string[]) => ({ argv, exitCode: 0 }));
    await expect(runHarnessDevelopmentCli([
      "--subject", "dev",
      "--subject-workspace", "D:/candidate"
    ], { runAgentEvalCli: runner })).resolves.toMatchObject({ exitCode: 0 });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      "--suite", "harness-development",
      "--provider", "openai-codex",
      "--model", "gpt-5.6-sol",
      "--reasoning-effort", "max",
      "--repeat", "3"
    ]));
    await expect(runHarnessDevelopmentCli(["--repeat", "1"], {
      runAgentEvalCli: runner
    })).rejects.toThrow(/controls are frozen/u);
    await expect(runHarnessDevelopmentCli(["--scenario", "one"], {
      runAgentEvalCli: runner
    })).rejects.toThrow(/controls are frozen/u);
  });

  it("reduces the host credential store to the selected provider", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-credential-"));
    temporary.push(directory);
    const credentialFile = path.join(directory, "auth.json");
    await writeFile(credentialFile, JSON.stringify({
      version: 1,
      credentials: {
        "openai-codex": {
          type: "oauth",
          access: "selected-access-token",
          refresh: "selected-refresh-token",
          expires: 1_900_000_000_000
        },
        unrelated: { type: "api_key", key: "must-not-copy" }
      }
    }), { encoding: "utf8", mode: 0o600 });

    const access = loadEvalProviderAccess("openai-codex", {
      base: { SIGMA_HOST_CREDENTIAL_FILE: credentialFile }
    });
    expect(access.environmentSecrets).toEqual({});
    expect(access.credentialDocument).toEqual({
      version: 1,
      credentials: {
        "openai-codex": {
          type: "oauth",
          access: "selected-access-token",
          refresh: "selected-refresh-token",
          expires: 1_900_000_000_000
        }
      }
    });
    expect(JSON.stringify(access)).not.toContain("must-not-copy");
    expect(access.secretValues).toEqual([
      "selected-access-token",
      "selected-refresh-token"
    ]);
  });
});
