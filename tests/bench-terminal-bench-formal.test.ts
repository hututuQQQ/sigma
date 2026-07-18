import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateFormalReports,
  runFormalBenchmark,
  validateFormalPlan
} from "../scripts/bench-terminal-bench-formal.mjs";

function plan() {
  return {
    task_repo: "https://example.test/tasks.git",
    task_commit: "a".repeat(40),
    benchmark: "generic-conformance",
    batches: [
      { batch: "001", tasks: [{ task_path: "tasks/one" }, { task_path: "tasks/two" }] },
      { batch: "002", tasks: [{ task_path: "tasks/three" }] }
    ]
  };
}

function report(taskCount: number, passed: number) {
  const tasks = Array.from({ length: taskCount }, (_unused, index) => ({
    task_id: `task-${index}`,
    status: index < passed ? "passed" : "failed",
    validity: "valid",
    verifier_outcome: index < passed ? "passed" : "failed",
    failure_category: index < passed ? null : "verifier_failed",
    input_tokens: 10,
    cache_tokens: 8,
    output_tokens: 2,
    cost_usd: 0.01
  }));
  return {
    agent_profile: "standard",
    evaluation_lane: "solving",
    incomplete_reason: null,
    trial_accounting: {
      expected: taskCount, observed: taskCount, scored: taskCount, errored: 0, missing: 0,
      meanReward: passed / taskCount
    },
    counts: { passed, failed: taskCount - passed, infra_failed: 0, timeout: 0, api_error: 0, unknown: 0 },
    usage: { input_tokens: taskCount * 10, cache_tokens: taskCount * 8, output_tokens: taskCount * 2 },
    cost_usd: taskCount * 0.01,
    tasks
  };
}

describe("formal benchmark controller", () => {
  it("validates fixed batch cardinality, uniqueness, and task Git commit", () => {
    const validated = validateFormalPlan(plan(), {
      taskCommit: "a".repeat(40), expectedTasks: 3, expectedBatches: 2, batchSize: 2
    });
    expect(validated.batches[0].tasks[0]).toEqual({
      path: "tasks/one",
      git_url: "https://example.test/tasks.git",
      git_commit_id: "a".repeat(40),
      source: "generic-conformance"
    });
  });

  it("aggregates complete trial accounting, failure categories, usage, and cost", () => {
    const validated = validateFormalPlan(plan(), {
      taskCommit: "a".repeat(40), expectedTasks: 3, expectedBatches: 2, batchSize: 2
    });
    const aggregate = aggregateFormalReports(validated, [
      { batch: "001", report: report(2, 1) },
      { batch: "002", report: report(1, 1) }
    ], 2);
    expect(aggregate).toMatchObject({
      status: "complete",
      acceptance: "passed",
      agent_profile: "standard",
      evaluation_lane: "solving",
      lane_metrics: { verifier_reached: 3, verifier_passed: 2, verifier_pass_rate: 2 / 3 },
      trial_accounting: { expected: 3, observed: 3, missing: 0 },
      counts: { passed: 2, failed: 1 },
      failure_categories: { verifier_failed: 1 },
      usage: { input_tokens: 30, cache_tokens: 24, output_tokens: 6 },
      cost_usd: 0.03
    });
  });

  it("refuses to aggregate batches from different profiles or evaluation lanes", () => {
    const validated = validateFormalPlan(plan(), {
      taskCommit: "a".repeat(40), expectedTasks: 3, expectedBatches: 2, batchSize: 2
    });
    expect(() => aggregateFormalReports(validated, [
      { batch: "001", report: report(2, 1) },
      {
        batch: "002",
        report: { ...report(1, 1), agent_profile: "strict", evaluation_lane: "strict_conformance" }
      }
    ], 2)).toThrow(/different agent profiles/u);
  });

  it("runs exactly one frozen batch per invocation and writes a resumable aggregate report", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-"));
    const planPath = path.join(directory, "plan.json");
    const output = path.join(directory, "output");
    await writeFile(planPath, `${JSON.stringify(plan())}\n`, "utf8");
    const seen: string[] = [];
    const result = await runFormalBenchmark([
      "--plan", planPath, "--task-commit", "a".repeat(40),
      "--archive-sha256", "b".repeat(64), "--expected-tasks", "3",
      "--expected-batches", "2", "--batch-size", "2", "--minimum-passes", "2",
      "--output", output, "--batch", "001"
    ], {
      runBatch: async (_validatedPlan: unknown, batch: { id: string; tasks: unknown[] }) => {
        seen.push(batch.id);
        return { exitCode: 1, runDir: `run-${batch.id}`, report: report(batch.tasks.length, 1) };
      }
    });
    const resumed = await runFormalBenchmark([
      "--plan", planPath, "--task-commit", "a".repeat(40),
      "--archive-sha256", "b".repeat(64), "--expected-tasks", "3",
      "--expected-batches", "2", "--batch-size", "2", "--minimum-passes", "2",
      "--output", output, "--batch", "002", "--resume"
    ], {
      runBatch: async (_validatedPlan: unknown, batch: { id: string; tasks: unknown[] }) => {
        seen.push(batch.id);
        return { exitCode: 1, runDir: `run-${batch.id}`, report: report(batch.tasks.length, 1) };
      }
    });
    try {
      expect(seen).toEqual(["001", "002"]);
      expect(result.report.status).toBe("incomplete");
      expect(resumed.report.status).toBe("complete");
      expect(JSON.parse(await readFile(path.join(output, "report.json"), "utf8"))).toMatchObject({
        trial_accounting: { expected: 3, observed: 3 }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to retry a batch left in started state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-interrupted-"));
    const planPath = path.join(directory, "plan.json");
    const output = path.join(directory, "output");
    await writeFile(planPath, `${JSON.stringify(plan())}\n`, "utf8");
    const args = [
      "--plan", planPath, "--task-commit", "a".repeat(40),
      "--archive-sha256", "b".repeat(64), "--expected-tasks", "3",
      "--expected-batches", "2", "--batch-size", "2", "--output", output, "--batch", "001"
    ];
    await expect(runFormalBenchmark(args, {
      runBatch: async () => { throw new Error("controller interrupted"); }
    })).rejects.toThrow("controller interrupted");
    await expect(runFormalBenchmark([...args, "--resume"], {
      runBatch: async () => { throw new Error("must not run"); }
    })).rejects.toThrow("retrying it is prohibited");
    await rm(directory, { recursive: true, force: true });
  });
});
