import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRepositoryStatistics,
  type RepositoryLanguageStatistics,
  type RepositoryTopLevelDirectoryStatistics
} from "../packages/agent-context/src/index.js";
import { repositoryTools } from "../packages/agent-tools/src/index.js";

interface Metrics {
  files: number;
  physicalLines: number;
  nonBlankLines: number;
  bytes: number;
}

function summed(groups: ReadonlyArray<Metrics>): Metrics {
  return groups.reduce<Metrics>((total, group) => ({
    files: total.files + group.files,
    physicalLines: total.physicalLines + group.physicalLines,
    nonBlankLines: total.nonBlankLines + group.nonBlankLines,
    bytes: total.bytes + group.bytes
  }), { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 });
}

describe("repository statistics top-level directory contract", () => {
  it("bounds stable groups while conserving every accepted metric", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-statistics-directories-"));
    const files = [
      { file: "root.ts", content: "x" },
      { file: "alpha/main.ts", content: "a\nb\nc\nd" },
      { file: "beta/main.py", content: "a\nb\nc" },
      { file: "gamma/main.rs", content: "a\nb" },
      { file: "delta/main.go", content: "x" },
      { file: "epsilon/Main.java", content: "x" }
    ];
    try {
      await Promise.all([
        ...new Set(files.map(({ file }) => path.dirname(file)).filter((directory) => directory !== "."))
      ].map(async (directory) => await mkdir(path.join(workspace, directory), { recursive: true })));
      await Promise.all(files.map(async ({ file, content }) => {
        await writeFile(path.join(workspace, file), content, "utf8");
      }));

      const signal = new AbortController().signal;
      const options = {
        deadline: performance.now() + 10_000,
        maxTopLevelDirectories: 3
      };
      const first = await collectRepositoryStatistics(workspace, signal, options);
      const second = await collectRepositoryStatistics(workspace, signal, {
        ...options,
        deadline: performance.now() + 10_000
      });

      expect(first.complete).toBe(true);
      expect(first.scope.limits.maxTopLevelDirectories).toBe(3);
      expect(first.topLevelDirectories).toHaveLength(3);
      expect(first.topLevelDirectories.map(({ kind, directory }) => [kind, directory])).toEqual([
        ["directory", "alpha"],
        ["directory", "beta"],
        ["remainder", null]
      ]);
      expect(first.omittedDirectories).toBe(3);
      expect(first.topLevelDirectories).toEqual(second.topLevelDirectories);
      expect(first.omittedDirectories).toBe(second.omittedDirectories);
      expect(summed(first.languages satisfies RepositoryLanguageStatistics[])).toEqual(first.totals);
      expect(summed(
        first.topLevelDirectories satisfies RepositoryTopLevelDirectoryStatistics[]
      )).toEqual(first.totals);
      expect(first.scope.topLevelDirectories).toContain("remainder");
      expect(first.scope.topLevelDirectories).toContain("occupies one slot");
      expect(first.scope.topLevelDirectories).toContain("non-blank lines");
      expect(first.scope.topLevelDirectories).toContain("lexical order");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses locale-independent lexical ties and an explicit root group", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-statistics-order-"));
    try {
      await Promise.all([
        mkdir(path.join(workspace, "zeta")),
        mkdir(path.join(workspace, "alpha"))
      ]);
      await Promise.all([
        writeFile(path.join(workspace, "root.ts"), "x", "utf8"),
        writeFile(path.join(workspace, "zeta", "main.ts"), "x", "utf8"),
        writeFile(path.join(workspace, "alpha", "main.ts"), "x", "utf8")
      ]);

      const statistics = await collectRepositoryStatistics(
        workspace,
        new AbortController().signal,
        { deadline: performance.now() + 10_000 }
      );

      expect(statistics.topLevelDirectories.map(({ kind, directory }) => ({ kind, directory })))
        .toEqual([
          { kind: "root", directory: null },
          { kind: "directory", directory: "alpha" },
          { kind: "directory", directory: "zeta" }
        ]);
      expect(statistics.omittedDirectories).toBe(0);
      expect(summed(statistics.topLevelDirectories)).toEqual(statistics.totals);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps both grouping dimensions conservative for rejected and truncated reads", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-statistics-partial-"));
    try {
      await Promise.all([
        mkdir(path.join(workspace, "a")),
        mkdir(path.join(workspace, "b")),
        mkdir(path.join(workspace, "c"))
      ]);
      await Promise.all([
        writeFile(path.join(workspace, "a", "kept.ts"), "x", "utf8"),
        writeFile(path.join(workspace, "b", "oversized.ts"), "oversized", "utf8"),
        writeFile(path.join(workspace, "c", "kept.py"), "y", "utf8")
      ]);

      const rejected = await collectRepositoryStatistics(
        workspace,
        new AbortController().signal,
        {
          deadline: performance.now() + 10_000,
          maxFileBytes: 2
        }
      );
      expect(rejected).toMatchObject({
        complete: false,
        truncated: false,
        skippedSourceFiles: 1
      });
      expect(summed(rejected.languages)).toEqual(rejected.totals);
      expect(summed(rejected.topLevelDirectories)).toEqual(rejected.totals);

      const truncated = await collectRepositoryStatistics(
        workspace,
        new AbortController().signal,
        {
          deadline: performance.now() + 10_000,
          maxTotalBytes: 1
        }
      );
      expect(truncated.truncated).toBe(true);
      expect(summed(truncated.languages)).toEqual(truncated.totals);
      expect(summed(truncated.topLevelDirectories)).toEqual(truncated.totals);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("advertises bounded top-level aggregation in the public tool contract", () => {
    const statistics = repositoryTools(undefined, {
      statistics: () => Promise.resolve({ output: "{}" })
    }).find((tool) => tool.descriptor.name === "repository_stats");

    expect(statistics?.descriptor.description).toContain("bounded top-level directory groups");
  });

  it("returns no timing-dependent partial aggregates after a snapshot deadline", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-statistics-expired-"));
    try {
      await writeFile(path.join(workspace, "source.ts"), "x\n", "utf8");
      const statistics = await collectRepositoryStatistics(
        workspace,
        new AbortController().signal,
        { deadline: performance.now() - 1 }
      );

      expect(statistics).toMatchObject({
        complete: false,
        truncated: true,
        deadlineReached: true,
        snapshotFiles: 0,
        observedSourceFiles: 0,
        totals: { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 },
        languages: [],
        topLevelDirectories: []
      });
      expect(statistics.scope.selection).toContain("no partial counts or aggregates");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the bounded default for a non-finite deadline (%s)",
    async (deadline) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-statistics-deadline-"));
      try {
        await writeFile(path.join(workspace, "source.ts"), "x\n", "utf8");
        const statistics = await collectRepositoryStatistics(
          workspace,
          new AbortController().signal,
          { deadline }
        );

        expect(statistics.complete).toBe(true);
        expect(statistics.totals.files).toBe(1);
        expect(statistics.scope.limits.deadlineMs).toBeGreaterThan(0);
        expect(Number.isFinite(statistics.scope.limits.deadlineMs)).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  );
});
