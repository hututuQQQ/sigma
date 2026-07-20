import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pairedRunCohortSchedule,
  pairedRunCohortScheduleSha256,
  pairedRunTaskIdentitySha256,
  repositorySourceIdentity
} from "../scripts/bench-common.mjs";
import {
  installedAgentSubjectAttestation,
  normalizeCrossAgentRun
} from "../scripts/bench-cross-agent-normalize.mjs";

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(subjectKind: "archive" | "installed-agent" = "archive") {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-cross-agent-normalize-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  spawnSync("git", ["init"], { cwd: sourceRoot });
  spawnSync("git", ["config", "user.email", "test@example.test"], { cwd: sourceRoot });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: sourceRoot });
  await writeFile(path.join(sourceRoot, "README.md"), "source\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: sourceRoot });
  spawnSync("git", ["commit", "-m", "fixture"], { cwd: sourceRoot });
  const sourceIdentity = repositorySourceIdentity(sourceRoot);
  const archivePath = path.join(root, "agent.tgz");
  await writeFile(
    archivePath,
    subjectKind === "installed-agent"
      ? installedAgentSubjectAttestation("external-agent", "1.2.3")
      : "frozen agent archive",
    "utf8"
  );
  const archiveSha256 = digest(await readFile(archivePath));
  const taskRevision = "a".repeat(40);
  const taskSource = "https://example.test/frozen-suite.git";
  const tasks = [
    {
      pairing_key: "suite/a", path: "tasks/a", git_url: taskSource,
      source: "frozen-suite", git_commit_id: taskRevision,
      effective_solver_timeout_sec: 750, network_mode_effective: "full"
    },
    {
      pairing_key: "suite/b", path: "tasks/b", git_url: taskSource,
      source: "frozen-suite", git_commit_id: taskRevision,
      effective_solver_timeout_sec: 900, network_mode_effective: "full"
    }
  ];
  const cohortSchedule = pairedRunCohortSchedule(tasks, [750, 900]);
  const arm = {
    agent: "external-agent",
    version: "1.2.3",
    sourceRevision: sourceIdentity.revision,
    sourceDirty: sourceIdentity.dirty,
    sourceDiffSha256: sourceIdentity.dirtyDiffSha256,
    executionSubjectKind: subjectKind,
    executionSubjectSha256: archiveSha256
  };
  const plan = {
    schemaVersion: 1,
    kind: "sigma.benchmark-paired-run-plan",
    taskCount: tasks.length,
    tasks,
    controls: {
      model: "provider/model",
      taskRevision,
      networkMode: "full",
      concurrency: 5,
      attemptsPerArm: 1,
      retries: 0,
      cohortSchedule,
      cohortScheduleSha256: pairedRunCohortScheduleSha256(cohortSchedule)
    },
    arms: { baseline: arm, candidate: { ...arm, agent: "candidate-agent" } },
    armOrder: ["baseline", "candidate"]
  };
  const planPath = path.join(root, "plan.json");
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(planPath, planText, "utf8");
  const configPaths = [];
  const resolvedTaskPaths = [];
  const lockPaths = [];
  const jobsDir = path.join(root, "jobs");
  for (const cohort of cohortSchedule) {
    const taskKey = cohort.task_keys[0];
    const leaf = taskKey.split("/").at(-1);
    const configPath = path.join(root, `config-${cohort.order}.json`);
    const configText = `${JSON.stringify({
      n_attempts: 1,
      timeout_multiplier: 1,
      n_concurrent_trials: 5,
      retry: { max_retries: 0 },
      agents: [{
        name: "external-agent",
        model_name: "provider/model",
        ...(subjectKind === "installed-agent"
          ? { override_timeout_sec: cohort.effective_solver_timeout_sec } : {}),
        kwargs: {
          version: "1.2.3",
          ...(subjectKind === "archive" ? {
            network_mode: "full",
            max_wall_time_sec: cohort.effective_solver_timeout_sec,
            agent_cli_tarball: archivePath
          } : {})
        }
      }],
      tasks: [{
        path: `tasks/${leaf}`, git_url: taskSource,
        source: "frozen-suite", git_commit_id: taskRevision
      }]
    }, null, 2)}\n`;
    await writeFile(configPath, configText, "utf8");
    configPaths.push(configPath);
    const resolvedTaskPath = path.join(root, `resolved-${cohort.order}.json`);
    await writeFile(resolvedTaskPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: "sigma.harbor-resolved-task-attestation",
      job_config_sha256: digest(configText),
      tasks: [{
        task_identity: {
          path: `tasks/${leaf}`, git_url: taskSource,
          source: "frozen-suite", git_commit_id: taskRevision
        },
        task_config_sha256: digest(`task config ${leaf}`),
        effective_agent_network_mode: "public",
        agent_timeout_sec: cohort.effective_solver_timeout_sec
      }]
    }, null, 2)}\n`, "utf8");
    resolvedTaskPaths.push(resolvedTaskPath);
    const jobDir = path.join(jobsDir, `job-${cohort.order}`);
    const trialDir = path.join(jobDir, `trial-${cohort.order}`);
    await mkdir(trialDir, { recursive: true });
    const trial = {
      task: {
        name: taskKey, path: `tasks/${leaf}`, git_url: taskSource,
        source: "frozen-suite", git_commit_id: taskRevision
      },
      timeout_multiplier: 1,
      agent: {
        name: "external-agent", model_name: "provider/model",
        ...(subjectKind === "installed-agent"
          ? { override_timeout_sec: cohort.effective_solver_timeout_sec } : {}),
        kwargs: {
          version: "1.2.3",
          ...(subjectKind === "archive" ? {
            network_mode: "full",
            max_wall_time_sec: cohort.effective_solver_timeout_sec,
            agent_cli_tarball: archivePath
          } : {})
        }
      }
    };
    const lockPath = path.join(jobDir, "lock.json");
    await writeFile(lockPath, `${JSON.stringify({
      created_at: `2026-01-01T00:00:0${cohort.order}.000Z`,
      n_concurrent_trials: 5,
      retry: { max_retries: 0 },
      trials: [trial]
    }, null, 2)}\n`, "utf8");
    lockPaths.push(lockPath);
    await writeFile(path.join(trialDir, "result.json"), `${JSON.stringify({
      trial_name: `trial-${cohort.order}`,
      task_name: taskKey,
      source: "frozen-suite",
      task_id: { path: `tasks/${leaf}`, git_url: taskSource, git_commit_id: taskRevision },
      verifier_result: { rewards: { reward: cohort.order === 0 ? 1 : 0 }, secret: "discard" },
      solver_output: "discard"
    }, null, 2)}\n`, "utf8");
  }
  return {
    root,
    sourceRoot,
    archivePath,
    planPath,
    planSha256: digest(planText),
    configPaths,
    resolvedTaskPaths,
    lockPaths,
    plan,
    tasks,
    jobsDir
  };
}

async function mutateJson(filePath: string, mutate: (record: any) => void) {
  const record = JSON.parse(await readFile(filePath, "utf8"));
  mutate(record);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

describe("cross-agent control/result normalization", () => {
  it("attests ordered configs and locks while retaining only outcome classes", async () => {
    const item = await fixture();
    try {
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "result",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: [item.jobsDir]
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: true,
        configSha256s: [{ order: 0 }, { order: 1 }],
        lockSha256s: [expect.stringMatching(/^[a-f0-9]{64}$/u), expect.stringMatching(/^[a-f0-9]{64}$/u)]
      });
      expect(result.trials).toEqual([
        {
          pairing_key: "suite/a",
          task_identity_sha256: pairedRunTaskIdentitySha256(item.tasks[0]),
          paired_outcome: "verifier_passed"
        },
        {
          pairing_key: "suite/b",
          task_identity_sha256: pairedRunTaskIdentitySha256(item.tasks[1]),
          paired_outcome: "verifier_failed"
        }
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("solver_output");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("discard");
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("fails closed when config order or scheduler controls drift", async () => {
    const item = await fixture();
    try {
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "preflight",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: [...item.configPaths].reverse(),
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: []
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: false,
        issues: expect.arrayContaining(["cohort_membership_mismatch"])
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["config network", "preflight", "network_missing", (item: any) => mutateJson(
      item.configPaths[0], (record) => { delete record.agents[0].kwargs.network_mode; }
    )],
    ["config timeout", "preflight", "solver_timeout_missing", (item: any) => mutateJson(
      item.configPaths[0], (record) => { delete record.agents[0].kwargs.max_wall_time_sec; }
    )],
    ["lock network", "result", "lock_network_missing", (item: any) => mutateJson(
      item.lockPaths[0], (record) => { delete record.trials[0].agent.kwargs.network_mode; }
    )],
    ["lock timeout", "result", "lock_solver_timeout_missing", (item: any) => mutateJson(
      item.lockPaths[0], (record) => { delete record.trials[0].agent.kwargs.max_wall_time_sec; }
    )]
  ])("fails closed when %s evidence is absent", async (_label, phase, issue, mutate) => {
    const item = await fixture();
    try {
      await mutate(item);
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase,
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: phase === "result" ? [item.jobsDir] : []
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: false,
        issues: expect.arrayContaining([issue])
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("does not treat ignored installed-agent kwargs as deadline or network evidence", async () => {
    const item = await fixture("installed-agent");
    try {
      await mutateJson(item.configPaths[0], (record) => {
        delete record.agents[0].override_timeout_sec;
        record.agents[0].kwargs.max_wall_time_sec = 750;
        record.agents[0].kwargs.network_mode = "full";
      });
      await mutateJson(item.resolvedTaskPaths[0], (record) => {
        delete record.tasks[0].effective_agent_network_mode;
      });
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "preflight",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: []
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: false,
        issues: expect.arrayContaining([
          "solver_timeout_missing", "resolved_network_missing"
        ])
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("rejects JobConfig subject B when the caller supplies frozen subject A", async () => {
    const item = await fixture();
    try {
      const otherArchive = path.join(item.root, "agent-b.tgz");
      await writeFile(otherArchive, "different agent archive", "utf8");
      await mutateJson(item.configPaths[0], (record) => {
        record.agents[0].kwargs.agent_cli_tarball = otherArchive;
      });
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "preflight",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: []
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: false,
        issues: expect.arrayContaining(["execution_subject_mismatch"])
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["self-reported agent drift", {
      schemaVersion: 1, kind: "sigma.benchmark-installed-agent-subject",
      agent: "other-agent", version: "1.2.3"
    }],
    ["an unknown field", {
      schemaVersion: 1, kind: "sigma.benchmark-installed-agent-subject",
      agent: "external-agent", version: "1.2.3", extra: true
    }]
  ])("rejects installed-agent attestation with %s", async (_label, attestation) => {
    const item = await fixture("installed-agent");
    try {
      const subjectText = `${JSON.stringify(attestation)}\n`;
      await writeFile(item.archivePath, subjectText, "utf8");
      item.plan.arms.baseline.executionSubjectSha256 = digest(subjectText);
      const planText = `${JSON.stringify(item.plan, null, 2)}\n`;
      await writeFile(item.planPath, planText, "utf8");
      await expect(normalizeCrossAgentRun({
        arm: "baseline",
        phase: "preflight",
        planPath: item.planPath,
        expectedPlanSha256: digest(planText),
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: []
      })).rejects.toThrow(/subject attestation|subject kind/iu);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("rejects installed-agent version drift in a job-level lock", async () => {
    const item = await fixture("installed-agent");
    try {
      await mutateJson(item.lockPaths[0], (record) => {
        record.trials[0].agent.kwargs.version = "9.9.9";
      });
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "result",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: [item.jobsDir]
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: false,
        issues: expect.arrayContaining([
          "lock_version_mismatch", "lock_execution_subject_mismatch"
        ])
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["source", (task: any) => { task.source = "other-suite"; }],
    ["path", (task: any) => { task.path = "other/a"; }],
    ["revision", (task: any) => { task.git_commit_id = "b".repeat(40); }]
  ])("rejects the same basename with a different %s", async (_label, mutate) => {
    const item = await fixture();
    try {
      await mutateJson(item.configPaths[0], (record) => mutate(record.tasks[0]));
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "preflight",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: []
      });
      expect(result.run_input_attestation).toMatchObject({
        valid: false,
        issues: expect.arrayContaining(["cohort_membership_mismatch"])
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("retains manual stops and structured blockers as scalar outcome classes", async () => {
    const item = await fixture();
    try {
      await mutateJson(path.join(item.jobsDir, "job-0", "trial-0", "result.json"), (record) => {
        record.verifier_result = null;
        record.agent_result = { metadata: { termination_source: "manual_stop" } };
      });
      await mutateJson(path.join(item.jobsDir, "job-1", "trial-1", "result.json"), (record) => {
        record.verifier_result = null;
        record.agent_result = { metadata: { agent_outcome: "blocked" } };
      });
      const result = await normalizeCrossAgentRun({
        arm: "baseline",
        phase: "result",
        planPath: item.planPath,
        expectedPlanSha256: item.planSha256,
        sourceRoot: item.sourceRoot,
        archivePath: item.archivePath,
        configPaths: item.configPaths,
        resolvedTaskPaths: item.resolvedTaskPaths,
        jobsDirs: [item.jobsDir]
      });
      expect(result.trials.map((trial) => trial.paired_outcome)).toEqual([
        "manual_stop", "structured_blocker"
      ]);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });
});
