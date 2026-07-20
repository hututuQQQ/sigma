import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executePreparedCrossAgentPair,
  prepareCrossAgentPair
} from "../scripts/bench-cross-agent-paired.mjs";
import { repositorySourceIdentity } from "../scripts/bench-common.mjs";

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function gitRepository(parent: string, name: string) {
  const directory = path.join(parent, name);
  await mkdir(directory);
  spawnSync("git", ["init"], { cwd: directory, windowsHide: true });
  spawnSync("git", ["config", "user.email", "test@example.test"], {
    cwd: directory, windowsHide: true
  });
  spawnSync("git", ["config", "user.name", "Test"], {
    cwd: directory, windowsHide: true
  });
  await writeFile(path.join(directory, "README.md"), `${name}\n`, "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: directory, windowsHide: true });
  spawnSync("git", ["commit", "-m", "fixture"], { cwd: directory, windowsHide: true });
  return directory;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-paired-prepare-"));
  const candidateSource = await gitRepository(root, "candidate-source");
  const candidateIdentity = repositorySourceIdentity(candidateSource);
  const archivePath = path.join(root, "candidate.tgz");
  const harborPath = path.join(root, process.platform === "win32" ? "harbor.exe" : "harbor");
  const adapterPath = path.join(root, "installed-agent.py");
  await writeFile(archivePath, "candidate archive", "utf8");
  await writeFile(harborPath, "harbor executable", "utf8");
  await writeFile(adapterPath, "class InstalledAgent: pass\n", "utf8");
  const taskRevision = "a".repeat(40);
  const tasks = [750, 900, 900].map((_timeout, index) => ({
    path: `tasks/case-${index}`,
    git_url: "https://example.test/frozen-suite.git",
    git_commit_id: taskRevision,
    source: "frozen-suite"
  }));
  const timeoutByPath = new Map(tasks.map((task, index) => [task.path, [750, 900, 900][index]]));
  const spec = {
    schemaVersion: 1,
    kind: "sigma.benchmark-cross-agent-prepare-spec",
    tasks,
    controls: {
      model: "provider/model",
      taskRevision,
      networkMode: "full",
      concurrency: 3,
      attemptsPerArm: 1,
      retries: 0,
      cleanupGraceSec: 120
    },
    arms: {
      baseline: {
        agent: "installed-agent",
        configAgentName: "installed-agent",
        version: "1.2.3",
        executionSubjectKind: "installed-agent",
        adapterPath
      },
      candidate: {
        agent: "sigma",
        configAgentName: "sigma_harbor_agent:SigmaCliHarborAgent",
        executionSubjectKind: "archive",
        sourceRoot: candidateSource,
        archivePath
      }
    },
    armOrder: ["baseline", "candidate"]
  };
  const probeJobConfig = async (configPath: string) => {
    const bytes = await readFile(configPath);
    const config = JSON.parse(bytes.toString("utf8"));
    return {
      schemaVersion: 1,
      kind: "sigma.harbor-resolved-task-attestation",
      job_config_sha256: digest(bytes),
      tasks: config.tasks.map((task: any) => ({
        task_name: `terminal-bench/${path.posix.basename(task.path)}`,
        task_path: task.path,
        task_identity: task,
        task_config_sha256: digest(`config:${task.path}`),
        effective_agent_network_mode: "public",
        agent_timeout_sec: timeoutByPath.get(task.path),
        verifier_timeout_sec: 60,
        environment_build_timeout_sec: 60
      })),
      resolved_tasks: config.tasks,
      max_agent_timeout_sec: Math.max(...config.tasks.map(
        (task: any) => timeoutByPath.get(task.path)
      ))
    };
  };
  const deps = {
    harborInspection: async () => ({
      commandPath: harborPath,
      commandSha256: digest(await readFile(harborPath)),
      version: "harbor test",
      helpSha256: digest("--yes"),
      yesFlag: "--yes"
    }),
    probeJobConfig,
    agentCliArchiveSourceIdentity: () => ({
      revision: candidateIdentity.revision,
      dirty: candidateIdentity.dirty
    }),
    now: () => new Date("2026-01-01T00:00:00.000Z")
  };
  return { root, spec, deps, harborPath };
}

async function writeSuccessfulHarborResult(configPath: string) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const cohort = Number(path.basename(configPath).match(/(\d+)/u)?.[1] ?? 0);
  const jobDir = path.join(config.jobs_dir, `job-${cohort}`);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock.json"), `${JSON.stringify({
    created_at: `2026-01-01T00:00:0${cohort}.000Z`,
    n_concurrent_trials: config.n_concurrent_trials,
    retry: config.retry,
    trials: config.tasks.map((task: any) => ({
      task,
      timeout_multiplier: config.timeout_multiplier,
      agent: config.agents[0]
    }))
  }, null, 2)}\n`, "utf8");
  for (const [index, task] of config.tasks.entries()) {
    const trialDir = path.join(jobDir, `trial-${index}`);
    await mkdir(trialDir, { recursive: true });
    await writeFile(path.join(trialDir, "result.json"), `${JSON.stringify({
      trial_name: `trial-${cohort}-${index}`,
      task_name: `${task.source}/${path.posix.basename(task.path)}`,
      ...task,
      verifier_result: { rewards: { reward: 1 } }
    }, null, 2)}\n`, "utf8");
  }
}

describe("cross-agent paired prepare/execute separation", () => {
  it("freezes both arms and preflights them without starting a solver", async () => {
    const item = await fixture();
    const output = path.join(item.root, "prepared");
    let solverCalls = 0;
    try {
      const prepared = await prepareCrossAgentPair(item.spec, output, {
        ...item.deps,
        runProcess: async () => {
          solverCalls += 1;
          throw new Error("prepare must not execute Harbor");
        }
      });
      expect(solverCalls).toBe(0);
      expect(prepared.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(prepared.manifest).toMatchObject({
        kind: "sigma.benchmark-paired-preparation",
        status: "prepared",
        armOrder: ["baseline", "candidate"],
        seal: { algorithm: "sha256" }
      });
      expect(prepared.manifest.arms.baseline.cohorts).toHaveLength(2);
      expect(prepared.manifest.arms.candidate.cohorts).toHaveLength(2);
      const frozenPlan = JSON.parse(await readFile(path.join(
        output, prepared.manifest.plan.path
      ), "utf8"));
      expect(frozenPlan.arms.baseline).toMatchObject({
        sourceProvenanceKind: "installed-adapter",
        installedAdapterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(frozenPlan.arms.baseline).not.toHaveProperty("sourceRevision");
      const baselineConfig = JSON.parse(await readFile(path.join(
        output, prepared.manifest.arms.baseline.cohorts[0].config.path
      ), "utf8"));
      expect(baselineConfig).toMatchObject({
        n_attempts: 1,
        timeout_multiplier: 1,
        n_concurrent_trials: 3,
        retry: { max_retries: 0 },
        agents: [{
          name: "installed-agent",
          model_name: "provider/model",
          override_timeout_sec: 750,
          kwargs: { version: "1.2.3" }
        }]
      });
      expect(baselineConfig).not.toHaveProperty("override_timeout_sec");
      expect(baselineConfig.agents[0].kwargs).not.toHaveProperty("max_wall_time_sec");
      const candidateConfig = JSON.parse(await readFile(path.join(
        output, prepared.manifest.arms.candidate.cohorts[0].config.path
      ), "utf8"));
      expect(candidateConfig.agents[0]).not.toHaveProperty("override_timeout_sec");
      expect(candidateConfig.agents[0].kwargs).toMatchObject({
        model: "provider/model",
        network_mode: "full",
        max_wall_time_sec: 750
      });
      expect(JSON.parse(await readFile(
        path.join(output, prepared.manifest.pairedPreflight.path), "utf8"
      ))).toMatchObject({ comparable: true, mismatchReasons: [] });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("executes only digest-matched configs in the frozen arm/cohort order", async () => {
    const item = await fixture();
    const output = path.join(item.root, "prepared");
    try {
      const prepared = await prepareCrossAgentPair(item.spec, output, item.deps);
      const calls: Array<{ command: string; args: string[] }> = [];
      const result = await executePreparedCrossAgentPair(
        prepared.manifestPath, prepared.manifestSha256,
        {
          now: item.deps.now,
          runProcess: async (command: string, args: string[]) => {
            calls.push({ command, args });
            await writeSuccessfulHarborResult(args[2]);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      );
      expect(result.status).toBe("completed");
      expect(calls.map((call) => path.basename(call.args[2]))).toEqual([
        "cohort-000.json", "cohort-001.json", "cohort-000.json", "cohort-001.json"
      ]);
      expect(calls.every((call) => call.command === item.harborPath)).toBe(true);
      expect(calls.every((call) => call.args.at(-1) === "--yes")).toBe(true);
      expect(result).toMatchObject({
        pairedStatus: "reported",
        comparable: true,
        outcomeStatus: "complete"
      });
      expect(JSON.parse(await readFile(
        path.join(output, result.pairedReport.path), "utf8"
      ))).toMatchObject({
        status: "reported",
        comparable: true,
        arms: {
          baseline: { verifierReached: 3, verifierPassed: 3 },
          candidate: { verifierReached: 3, verifierPassed: 3 }
        }
      });
      await expect(executePreparedCrossAgentPair(
        prepared.manifestPath, prepared.manifestSha256, {
          runProcess: async () => ({ exitCode: 0, stdout: "", stderr: "" })
        }
      )).rejects.toMatchObject({ code: "paired_execution_already_started" });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("fails before execution when the external pin or a frozen config drifts", async () => {
    const first = await fixture();
    try {
      const prepared = await prepareCrossAgentPair(
        first.spec, path.join(first.root, "prepared"), first.deps
      );
      let calls = 0;
      await expect(executePreparedCrossAgentPair(
        prepared.manifestPath, "f".repeat(64), {
          runProcess: async () => { calls += 1; return { exitCode: 0 }; }
        }
      )).rejects.toThrow(/externally pinned/iu);
      expect(calls).toBe(0);

      const config = path.join(
        prepared.outputDir, prepared.manifest.arms.baseline.cohorts[0].config.path
      );
      await writeFile(config, "{}\n", "utf8");
      await expect(executePreparedCrossAgentPair(
        prepared.manifestPath, prepared.manifestSha256, {
          runProcess: async () => { calls += 1; return { exitCode: 0 }; }
        }
      )).rejects.toThrow(/artifact digest mismatch/iu);
      expect(calls).toBe(0);
    } finally {
      await rm(first.root, { recursive: true, force: true });
    }
  });

  it("continues later frozen cohorts after a non-zero exit without retrying", async () => {
    const item = await fixture();
    const output = path.join(item.root, "prepared");
    try {
      const prepared = await prepareCrossAgentPair(item.spec, output, item.deps);
      const configs: string[] = [];
      const result = await executePreparedCrossAgentPair(
        prepared.manifestPath, prepared.manifestSha256, {
          runProcess: async (_command: string, args: string[]) => {
            configs.push(args[2]);
            await writeSuccessfulHarborResult(args[2]);
            return { exitCode: configs.length === 1 ? 1 : 0, stdout: "", stderr: "" };
          }
        }
      );
      expect(result).toMatchObject({
        status: "failed",
        pairedStatus: "reported",
        comparable: true,
        executionPolicy: {
          attemptsPerConfig: 1,
          retries: 0,
          continueAfterCohortFailure: true,
          resultNormalization: "after_all_arms"
        }
      });
      expect(configs).toHaveLength(4);
      expect(new Set(configs)).toHaveLength(4);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });
});
