import { describe, expect, it } from "vitest";
import { createBenchmarkSamplePlan } from "../scripts/bench-sample-plan.mjs";

function catalog() {
  const tasks = [];
  for (const [difficulty, count] of [["easy", 4], ["medium", 8], ["hard", 6]] as const) {
    for (let index = 0; index < count; index += 1) {
      tasks.push({
        difficulty,
        path: `tasks/${difficulty}-${index}`,
        git_url: "https://example.test/tasks.git",
        git_commit_id: "a".repeat(40),
        source: "external-catalog"
      });
    }
  }
  return { schemaVersion: 1, tasks };
}

describe("frozen benchmark sample planning", () => {
  it("selects exact deterministic strata without adding catalog metadata to runner tasks", () => {
    const options = { seed: "sealed-seed", quotas: { easy: 2, medium: 6, hard: 4 }, createdAt: "2026-07-19T00:00:00.000Z" };
    const first = createBenchmarkSamplePlan(catalog(), options);
    const second = createBenchmarkSamplePlan(catalog(), options);
    expect(first).toEqual(second);
    expect(first.taskCount).toBe(12);
    expect(first.tasksSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.tasks.filter((task) => task.path.includes("/easy-"))).toHaveLength(2);
    expect(first.tasks.filter((task) => task.path.includes("/medium-"))).toHaveLength(6);
    expect(first.tasks.filter((task) => task.path.includes("/hard-"))).toHaveLength(4);
    expect(first.tasks.every((task) => !("difficulty" in task))).toBe(true);
  });

  it("fails closed for duplicate identities and underfilled strata", () => {
    const duplicate = catalog();
    duplicate.tasks.push({ ...duplicate.tasks[0]! });
    expect(() => createBenchmarkSamplePlan(duplicate, {
      seed: "seed", quotas: { easy: 2 }
    })).toThrow(/duplicate task identities/iu);
    expect(() => createBenchmarkSamplePlan(catalog(), {
      seed: "seed", quotas: { easy: 5 }
    })).toThrow(/quota requires 5/iu);
  });
});
