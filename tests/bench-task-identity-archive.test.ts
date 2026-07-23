import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTaskIdentityArchive,
  writeTaskIdentityArchive
} from "../scripts/bench-task-identity-archive.mjs";
import {
  buildResolvedTaskAttestationV2,
  harborTaskExecutionIdentitySha256,
  taskSelectionIdentitySha256
} from "../scripts/harbor-task-identity.mjs";
import {
  sha256,
  sigmaFormalRunPreregistrationV1
} from "../scripts/bench-terminal-bench-formal-preregistration.mjs";

const commit = "a".repeat(40);

function task(name: string, provenance = "catalog") {
  return {
    path: `tasks/${name}`,
    git_url: "https://example.test/tasks.git",
    git_commit_id: commit,
    provenance_source: provenance
  };
}

function preregistration(tasks: Array<ReturnType<typeof task>>) {
  return sigmaFormalRunPreregistrationV1({
    formal_run_id: "archive-fixture",
    source: { revision: "c".repeat(40), dirty: false, diff_sha256: null },
    archive_sha256: "b".repeat(64),
    model: { provider: "provider", name: "model" },
    task_selection: {
      dataset: "generic",
      terminal_bench_revision: commit,
      tasks
    },
    solver_controls: {
      benchmark_class: "standard",
      agent_profile: "standard",
      max_turns: 10,
      command_timeout_sec: 20,
      cleanup_grace_sec: 30
    },
    execution: {
      network_mode: "full",
      execution_mode: "sandboxed",
      managed_environment_mode: "disabled",
      harbor_topology: "main_only",
      concurrency: 1,
      attempts_per_task: 1,
      retries: 0,
      package_mode: "reuse",
      batches: [{
        id: "only",
        task_indexes: tasks.map((_task, index) => index),
        timeout_cohorts: [{
          id: "timeout",
          task_indexes: tasks.map((_task, index) => index),
          effective_solver_timeout_sec: 900
        }]
      }]
    }
  });
}

describe("task identity archive", () => {
  it("collects only allowlisted frozen sources and deduplicates identities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-task-archive-"));
    const first = task("one");
    const second = task("two");
    try {
      await writeFile(path.join(root, "prior.tasks.json"), `${JSON.stringify([first, second])}\n`);
      await writeFile(
        path.join(root, "frozen-preregistration.json"),
        `${JSON.stringify(preregistration([first]))}\n`
      );
      const attestationDirectory = path.join(root, "resolved");
      await mkdir(attestationDirectory);
      const attestation = buildResolvedTaskAttestationV2({
        jobConfigSha256: "d".repeat(64),
        taskSelectionSha256: "e".repeat(64),
        selectedTasks: [second],
        resolvedTasks: [second]
      });
      await writeFile(
        path.join(attestationDirectory, "resolved-task-attestation.v2.json"),
        `${JSON.stringify(attestation)}\n`
      );
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, "node_modules", "ignored.tasks.json"), JSON.stringify([task("ignored")]));

      const archive = await createTaskIdentityArchive(root, {
        createdAt: "2026-07-22T00:00:00.000Z"
      });
      expect(archive).toMatchObject({
        kind: "SigmaTaskIdentityArchiveV1",
        source_count: 3,
        execution_identity_count: 2,
        selection_identity_count: 2
      });
      expect(archive.execution_identity_sha256s).toEqual(expect.arrayContaining([
        harborTaskExecutionIdentitySha256(first),
        harborTaskExecutionIdentitySha256(second)
      ]));
      expect(archive.selection_identity_sha256s).toEqual(expect.arrayContaining([
        taskSelectionIdentitySha256(first),
        taskSelectionIdentitySha256(second)
      ]));
      expect(archive.sources.map((source: { path: string }) => source.path)).toEqual([
        "frozen-preregistration.json",
        "prior.tasks.json",
        "resolved/resolved-task-attestation.v2.json"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered resolved identity attestation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-task-archive-tamper-"));
    try {
      const selected = task("one");
      const attestation = buildResolvedTaskAttestationV2({
        jobConfigSha256: "d".repeat(64),
        taskSelectionSha256: "e".repeat(64),
        selectedTasks: [selected],
        resolvedTasks: [selected]
      });
      attestation.tasks[0].selection_identity_sha256 = "0".repeat(64);
      await writeFile(
        path.join(root, "resolved-task-attestation.v2.json"),
        `${JSON.stringify(attestation)}\n`
      );
      await expect(createTaskIdentityArchive(root)).rejects.toThrow(/inconsistent/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes an immutable archive and refuses a second consumption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-task-archive-write-"));
    const output = path.join(root, "history.json");
    try {
      await writeFile(path.join(root, "prior.tasks.json"), JSON.stringify([task("one")]));
      const first = await writeTaskIdentityArchive(root, output, {
        createdAt: "2026-07-22T00:00:00.000Z"
      });
      expect(sha256(await readFile(output))).toBe(first.sha256);
      await expect(writeTaskIdentityArchive(root, output)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
