import { describe, expect, it, vi } from "vitest";
import type { HostSnapshotConsumer } from "../packages/agent-context/src/repository-host-snapshot.js";
import type { RepositorySnapshotAccess } from "../packages/agent-context/src/repository-snapshot-access.js";

const snapshot = vi.hoisted(() => ({
  files: [] as string[],
  contents: new Map<string, string>(),
  deadlineReached: false,
  onRead: undefined as (() => void) | undefined
}));

vi.mock("../packages/agent-context/src/repository-host-snapshot.js", () => ({
  withHostRepositorySnapshot: (
    _workspace: string,
    _signal: AbortSignal,
    _options: unknown,
    consume: HostSnapshotConsumer<unknown>
  ): Promise<unknown> => {
    const access = {
      readText(relative: string, maxBytes: number, signal: AbortSignal) {
        signal.throwIfAborted();
        snapshot.onRead?.();
        const content = snapshot.contents.get(relative);
        return Promise.resolve(content !== undefined
          && Buffer.byteLength(content, "utf8") <= maxBytes
          ? { content, rejected: false }
          : { content: null, rejected: true });
      }
    } satisfies RepositorySnapshotAccess;
    return consume({
      files: [...snapshot.files],
      diff: "",
      truncated: false,
      deadlineReached: snapshot.deadlineReached,
      source: "host"
    }, access);
  }
}));

import { collectRepositoryStatistics } from "../packages/agent-context/src/repository-statistics.js";

describe("repository statistics candidate ordering", () => {
  it("uses the same lexical prefix for reversed snapshots at the total-byte boundary", async () => {
    const forward = ["zeta/main.ts", "alpha/main.ts", "middle/main.py"];
    snapshot.contents = new Map([
      ["zeta/main.ts", "zz"],
      ["alpha/main.ts", "a"],
      ["middle/main.py", "mmm"]
    ]);
    const collect = async () => await collectRepositoryStatistics(
      "unused-mocked-workspace",
      new AbortController().signal,
      { deadline: performance.now() + 10_000, maxTotalBytes: 3 }
    );

    snapshot.files = forward;
    const fromForwardSnapshot = await collect();
    snapshot.files = [...forward].reverse();
    const fromReversedSnapshot = await collect();

    expect(fromForwardSnapshot).toMatchObject({
      complete: false,
      truncated: true,
      totals: { files: 1 },
      topLevelDirectories: [{ kind: "directory", directory: "alpha", files: 1 }]
    });
    expect(fromReversedSnapshot).toMatchObject({
      complete: fromForwardSnapshot.complete,
      truncated: fromForwardSnapshot.truncated,
      observedSourceFiles: fromForwardSnapshot.observedSourceFiles,
      skippedSourceFiles: fromForwardSnapshot.skippedSourceFiles,
      totals: fromForwardSnapshot.totals,
      languages: fromForwardSnapshot.languages,
      topLevelDirectories: fromForwardSnapshot.topLevelDirectories,
      omittedDirectories: fromForwardSnapshot.omittedDirectories
    });
  });

  it("discards all partial aggregates when the read deadline is reached", async () => {
    snapshot.files = ["alpha/main.ts", "beta/main.py"];
    snapshot.contents = new Map([
      ["alpha/main.ts", "a"],
      ["beta/main.py", "b"]
    ]);
    let readStarted = false;
    snapshot.onRead = () => { readStarted = true; };
    const clock = vi.spyOn(performance, "now").mockImplementation(() => readStarted ? 100 : 0);
    try {
      const result = await collectRepositoryStatistics(
        "unused-mocked-workspace",
        new AbortController().signal,
        { deadline: 50 }
      );

      expect(result).toMatchObject({
        complete: false,
        truncated: true,
        deadlineReached: true,
        snapshotFiles: 0,
        observedSourceFiles: 0,
        skippedSourceFiles: 0,
        totals: { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 },
        languages: [],
        topLevelDirectories: [],
        omittedDirectories: 0
      });
    } finally {
      clock.mockRestore();
      snapshot.onRead = undefined;
    }
  });
});
