import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRepositoryStatistics,
  listRepositoryFiles,
  RepositoryContextProvider,
  searchRepositoryText
} from "../packages/agent-context/src/index.js";
import {
  hostRepositorySnapshot,
  withHostRepositorySnapshot
} from "../packages/agent-context/src/repository-host-snapshot.js";
import { BoundedRegexMatcher } from "../packages/agent-context/src/repository-regex-search.js";
import { readStableWorkspaceText } from "../packages/agent-context/src/repository-safe-read.js";
import {
  safeAutomaticDirectoryName,
  safeAutomaticDirectoryPath,
  safeAutomaticFileName,
  safeAutomaticFilePath
} from "../packages/agent-context/src/repository-path-safety.js";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import type { ProcessExecutionPort } from "../packages/agent-platform/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";

class InputGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "repository-context";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  readonly requests: ModelRequest[] = [];

  async complete(_request: ModelRequest): Promise<never> {
    throw new Error("This gateway is exercised through streaming.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "context-observed",
            name: "request_user_input",
            arguments: { message: "Repository context was observed." }
          }]
        },
        finishReason: "tool_calls"
      }
    };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

function exited(stdout: string) {
  return {
    state: "exited" as const,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    stdout,
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false
  };
}

describe("host repository context", () => {
  it("does not reinterpret a host filename separator as repository structure", () => {
    expect(safeAutomaticFileName("literal\\nested.ts")).toBe(false);
    expect(safeAutomaticFileName("literal/nested.ts")).toBe(false);
    expect(safeAutomaticFilePath("literal\\nested.ts")).toBe(false);
    expect(safeAutomaticDirectoryName("literal\\nested")).toBe(false);
    expect(safeAutomaticDirectoryPath("literal\\nested")).toBe(false);
  });

  it("does not reinterpret a POSIX directory backslash as a path separator", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-directory-separator-"));
    try {
      const literalDirectory = path.join(workspace, "literal\\nested");
      await mkdir(literalDirectory);
      await writeFile(path.join(literalDirectory, "value.ts"), "x\n", "utf8");

      const snapshot = await hostRepositorySnapshot(
        workspace, new AbortController().signal
      );

      expect(snapshot.files).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns host snapshot paths in deterministic lexical order", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-snapshot-order-"));
    try {
      await writeFile(path.join(workspace, "z.ts"), "z\n", "utf8");
      await writeFile(path.join(workspace, "a.ts"), "a\n", "utf8");
      await mkdir(path.join(workspace, "middle"), { recursive: true });
      await writeFile(path.join(workspace, "middle", "value.ts"), "middle\n", "utf8");

      const snapshot = await hostRepositorySnapshot(
        workspace, new AbortController().signal
      );

      expect(snapshot.files).toEqual(["a.ts", "middle/value.ts", "z.ts"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("counts source lines with stable reads and reports ignored or rejected coverage", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-stats-"));
    const linkedTarget = path.join(os.tmpdir(), `sigma-repository-stats-linked-${path.basename(workspace)}.ts`);
    try {
      await Promise.all([
        mkdir(path.join(workspace, "src"), { recursive: true }),
        mkdir(path.join(workspace, "ignored"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(path.join(workspace, ".gitignore"), "ignored/\n", "utf8"),
        writeFile(path.join(workspace, "src", "main.ts"), "const value = 1;\n\n// comment\n", "utf8"),
        writeFile(path.join(workspace, "src", "binary.rs"), "fn main() {}\0", "utf8"),
        writeFile(path.join(workspace, "src", "oversized.py"), "x".repeat(100), "utf8"),
        writeFile(path.join(workspace, "ignored", "hidden.go"), "package hidden\n", "utf8"),
        writeFile(linkedTarget, "export const linked = true;\n", "utf8")
      ]);
      await link(linkedTarget, path.join(workspace, "src", "linked.ts"));

      const statistics = await collectRepositoryStatistics(
        workspace,
        new AbortController().signal,
        { maxFileBytes: 40, maxTotalBytes: 1_000_000 }
      );

      expect(statistics).toMatchObject({
        complete: false,
        truncated: false,
        observedSourceFiles: 4,
        skippedSourceFiles: 3,
        totals: { files: 1, physicalLines: 3, nonBlankLines: 2 },
        languages: [{ language: "TypeScript", extensions: [".ts"], files: 1 }]
      });
      expect(statistics.scope.exclusions).toContain("Nested .gitignore");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(linkedTarget, { force: true });
    }
  });

  it("lists a bounded safe snapshot with nested ignore and zero-level glob semantics", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-list-"));
    try {
      await Promise.all([
        mkdir(path.join(workspace, "src"), { recursive: true }),
        mkdir(path.join(workspace, "src2"), { recursive: true }),
        mkdir(path.join(workspace, "ignored"), { recursive: true }),
        mkdir(path.join(workspace, ".hidden"), { recursive: true }),
        mkdir(path.join(workspace, "generated"), { recursive: true }),
        mkdir(path.join(workspace, "secrets"), { recursive: true }),
        mkdir(path.join(workspace, "vendor"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(path.join(workspace, ".gitignore"), [
          "ignored/",
          "!generated/",
          "!vendor/",
          "!.hidden/"
        ].join("\n"), "utf8"),
        writeFile(path.join(workspace, "src", ".gitignore"), "*.ts\n!keep.ts\n", "utf8"),
        writeFile(path.join(workspace, "root.ts"), "root\n", "utf8"),
        writeFile(path.join(workspace, "src", "keep.ts"), "keep\n", "utf8"),
        writeFile(path.join(workspace, "src", "drop.ts"), "drop\n", "utf8"),
        writeFile(path.join(workspace, "src2", "other.ts"), "other\n", "utf8"),
        writeFile(path.join(workspace, "ignored", "ignored.ts"), "ignored\n", "utf8"),
        writeFile(path.join(workspace, ".hidden", "hidden.ts"), "hidden\n", "utf8"),
        writeFile(path.join(workspace, "generated", "generated.ts"), "generated\n", "utf8"),
        writeFile(path.join(workspace, "secrets", "secret.ts"), "secret\n", "utf8"),
        writeFile(path.join(workspace, "vendor", "vendored.ts"), "vendor\n", "utf8"),
        writeFile(path.join(workspace, ".env"), "TOKEN=secret\n", "utf8"),
        writeFile(path.join(workspace, "AGENTS.md"), "control\n", "utf8")
      ]);
      await symlink(
        path.join(workspace, "src"),
        path.join(workspace, "src-link"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const root = await listRepositoryFiles(workspace, new AbortController().signal, {
        glob: "**/*.ts"
      });
      expect(root.complete).toBe(true);
      expect(root.entries).toEqual(["root.ts", "src/keep.ts", "src2/other.ts"]);
      expect(root.scope.exclusions).toContain("Nested .gitignore");

      const scoped = await listRepositoryFiles(workspace, new AbortController().signal, {
        path: "src",
        glob: "*.ts"
      });
      expect(scoped.entries).toEqual(["src/keep.ts"]);
      await expect(listRepositoryFiles(workspace, new AbortController().signal, {
        path: "missing-directory"
      })).rejects.toThrow(/does not exist/u);
      await expect(searchRepositoryText(workspace, new AbortController().signal, {
        query: "anything",
        path: "missing-directory"
      })).rejects.toThrow(/does not exist/u);
      await expect(listRepositoryFiles(workspace, new AbortController().signal, {
        path: "secrets"
      })).rejects.toThrow(/not an allowed/u);
      await expect(listRepositoryFiles(workspace, new AbortController().signal, {
        path: "src-link"
      })).rejects.toThrow(/not an allowed/u);

      await Promise.all(Array.from({ length: 50 }, (_, index) => writeFile(
        path.join(workspace, `non-match-${index.toString().padStart(2, "0")}.txt`),
        "",
        "utf8"
      )));
      await writeFile(path.join(workspace, "z-only.zig"), "", "utf8");
      const filtered = await listRepositoryFiles(workspace, new AbortController().signal, {
        glob: "*.zig",
        limit: 1
      });
      expect(filtered.complete).toBe(true);
      expect(filtered.entries).toEqual(["z-only.zig"]);

      await writeFile(path.join(workspace, `${"界".repeat(20)}.txt`), "", "utf8");
      const byteLimited = await listRepositoryFiles(workspace, new AbortController().signal, {
        glob: "*界*.txt",
        maxOutputBytes: 40
      });
      expect(byteLimited.outputBytes).toBeLessThanOrEqual(40);
      expect(byteLimited.limitsReached.outputBytes).toBe(true);
      expect(byteLimited.truncated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("searches only bounded safe repository text and reports rejected hard links", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-search-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-search-outside-"));
    try {
      await Promise.all([
        mkdir(path.join(workspace, "ignored"), { recursive: true }),
        mkdir(path.join(workspace, ".hidden"), { recursive: true }),
        mkdir(path.join(workspace, "src"), { recursive: true })
      ]);
      const outsideFile = path.join(outside, "outside.ts");
      await Promise.all([
        writeFile(path.join(workspace, ".gitignore"), "ignored/\n", "utf8"),
        writeFile(path.join(workspace, ".env"), "needle=secret\n", "utf8"),
        writeFile(path.join(workspace, "credentials.json"), "needle secret\n", "utf8"),
        writeFile(path.join(workspace, ".hidden", "hidden.ts"), "needle hidden\n", "utf8"),
        writeFile(path.join(workspace, "ignored", "drop.ts"), "needle ignored\n", "utf8"),
        writeFile(path.join(workspace, "root.ts"), "needle root\n", "utf8"),
        writeFile(path.join(workspace, "src", "keep.ts"), "needle source\n", "utf8"),
        writeFile(outsideFile, "needle outside\n", "utf8")
      ]);
      await link(outsideFile, path.join(workspace, "src", "linked.ts"));

      const search = await searchRepositoryText(workspace, new AbortController().signal, {
        query: "needle",
        glob: "**/*.ts",
        limit: 20
      });

      expect(search.matches.map((match) => match.file)).toEqual(["root.ts", "src/keep.ts"]);
      expect(search.matches.map((match) => match.text).join("\n")).not.toMatch(
        /secret|hidden|ignored|outside/u
      );
      expect(search.complete).toBe(false);
      expect(search.skippedFiles).toBe(1);
      expect(search.scope.exclusions).toContain("sensitive");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("excludes compound sensitive and backup names from automatic listing and search", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-compound-sensitive-"));
    try {
      await Promise.all([
        writeFile(path.join(workspace, "config.env.production"), "COMPOUND_SECRET=one\n", "utf8"),
        writeFile(path.join(workspace, "identity.pem.bak"), "COMPOUND_SECRET=two\n", "utf8"),
        writeFile(path.join(workspace, "credentials.json.backup"), "COMPOUND_SECRET=three\n", "utf8"),
        writeFile(path.join(workspace, "AGENTS.md.bak"), "COMPOUND_SECRET=control\n", "utf8"),
        writeFile(path.join(workspace, "visible.txt"), "ordinary content\n", "utf8")
      ]);

      const listing = await listRepositoryFiles(
        workspace, new AbortController().signal, { deadline: performance.now() + 5_000 }
      );
      expect(listing.complete).toBe(true);
      expect(listing.entries).toEqual(["visible.txt"]);

      const search = await searchRepositoryText(workspace, new AbortController().signal, {
        query: "COMPOUND_SECRET",
        deadline: performance.now() + 5_000
      });
      expect(search.complete).toBe(true);
      expect(search.matches).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed UTF-8 from automatic statistics and search", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-invalid-utf8-"));
    try {
      await writeFile(path.join(workspace, "bad.ts"), Buffer.from([0x66, 0x80, 0x6f, 0x0a]));
      const signal = new AbortController().signal;
      const statistics = await collectRepositoryStatistics(workspace, signal, {
        deadline: performance.now() + 5_000
      });
      expect(statistics).toMatchObject({
        complete: false,
        truncated: false,
        observedSourceFiles: 1,
        skippedSourceFiles: 1,
        totals: { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 }
      });

      const search = await searchRepositoryText(workspace, signal, {
        query: "\uFFFD",
        deadline: performance.now() + 5_000
      });
      expect(search).toMatchObject({ complete: false, truncated: false, skippedFiles: 1 });
      expect(search.matches).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("bounds regex, aggregate bytes, and serialized search output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-search-limits-"));
    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(
        path.join(workspace, "src", "values.ts"),
        "alpha123\nalpha\nalpha456\n",
        "utf8"
      );
      const regex = await searchRepositoryText(workspace, new AbortController().signal, {
        query: "^alpha[0-9]+$",
        regex: true,
        glob: "src/**/*.ts",
        limit: 10
      });
      expect(regex.complete).toBe(true);
      expect(regex.matches.map((match) => match.text)).toEqual(["alpha123", "alpha456"]);

      const outputLimited = await searchRepositoryText(workspace, new AbortController().signal, {
        query: "alpha",
        maxOutputBytes: 20,
        limit: 10
      });
      expect(outputLimited.truncated).toBe(true);
      expect(outputLimited.limitsReached.outputBytes).toBe(true);
      expect(outputLimited.outputBytes).toBeLessThanOrEqual(20);

      const bytesLimited = await searchRepositoryText(workspace, new AbortController().signal, {
        query: "alpha",
        maxTotalBytes: 1,
        limit: 10
      });
      expect(bytesLimited.truncated).toBe(true);
      expect(bytesLimited.limitsReached.totalBytes).toBe(true);
      expect(bytesLimited.scannedBytes).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("terminates pathological regular expressions at deadlines and cancellation", async () => {
    const content = `${"a".repeat(100_000)}!`;
    const deadlineMatcher = new BoundedRegexMatcher("(a+)+$");
    const started = performance.now();
    const deadlineOutcome = await deadlineMatcher.search(
      content,
      10,
      started + 100,
      new AbortController().signal
    );
    expect(deadlineOutcome.deadlineReached).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    await deadlineMatcher.close();

    const cancelledMatcher = new BoundedRegexMatcher("(a+)+$");
    const controller = new AbortController();
    const pending = cancelledMatcher.search(content, 10, performance.now() + 5_000, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled regex search")), 20);
    await expect(pending).rejects.toThrow("cancelled regex search");
    await cancelledMatcher.close();
  });

  it("rejects a repository read when its parent changes after target resolution", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-stable-read-race-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-stable-read-race-outside-"));
    const source = path.join(workspace, "src");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "value.ts"), "workspace value\n", "utf8");
      await writeFile(path.join(outside, "value.ts"), "outside secret\n", "utf8");
      let swapped = false;
      const loaded = await readStableWorkspaceText(
        workspace,
        "src/value.ts",
        1_000,
        new AbortController().signal,
        {
          afterTargetResolved: async () => {
            await rm(source, { recursive: true, force: true });
            await symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
            swapped = true;
          }
        }
      );
      expect(swapped).toBe(true);
      expect(loaded).toEqual({ content: null, rejected: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a repository read through an internal directory link", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-stable-read-link-"));
    try {
      const source = path.join(workspace, "source");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "value.ts"), "internal target\n", "utf8");
      await symlink(
        source,
        path.join(workspace, "linked"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const loaded = await readStableWorkspaceText(
        workspace,
        "linked/value.ts",
        1_000,
        new AbortController().signal
      );

      expect(loaded).toEqual({ content: null, rejected: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("binds POSIX reads to the initially resolved file across a parent-directory ABA", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-stable-read-aba-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-stable-read-aba-outside-"));
    const source = path.join(workspace, "src");
    const parked = path.join(workspace, "src-original");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "value.ts"), "workspace value\n", "utf8");
      await writeFile(path.join(outside, "value.ts"), "outside secret\n", "utf8");
      const loaded = await readStableWorkspaceText(
        workspace,
        "src/value.ts",
        1_000,
        new AbortController().signal,
        {
          beforeStableRead: async () => {
            await rename(source, parked);
            await symlink(outside, source, "dir");
          },
          afterStableRead: async () => {
            await rm(source);
            await rename(parked, source);
          }
        }
      );
      expect(loaded).toEqual({ content: null, rejected: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("enumerates a POSIX snapshot through the pinned directory across a root ABA", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-snapshot-aba-"));
    const parked = `${workspace}-parked`;
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-host-snapshot-aba-outside-"));
    let swapped = false;
    let restored = false;
    try {
      await writeFile(path.join(workspace, "inside.ts"), "workspace value\n", "utf8");
      await writeFile(path.join(outside, "outside-only.ts"), "outside secret\n", "utf8");

      const snapshot = await hostRepositorySnapshot(
        workspace,
        new AbortController().signal,
        {
          beforeDirectoryScanned: async (relative) => {
            if (relative !== "" || swapped) return;
            await rename(workspace, parked);
            await symlink(outside, workspace, "dir");
            swapped = true;
          },
          afterDirectoryScanned: async (relative) => {
            if (relative !== "" || !swapped || restored) return;
            await rm(workspace);
            await rename(parked, workspace);
            restored = true;
          }
        }
      );

      expect(swapped).toBe(true);
      expect(restored).toBe(true);
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.files).toContain("inside.ts");
      expect(snapshot.files).not.toContain("outside-only.ts");
    } finally {
      if (swapped && !restored) {
        await rm(workspace, { force: true }).catch(() => undefined);
        await rename(parked, workspace).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(parked, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads a snapshotted POSIX file through its pinned parent across a root ABA", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-snapshot-read-aba-"));
    const parked = `${workspace}-parked`;
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-host-snapshot-read-outside-"));
    const signal = new AbortController().signal;
    let swapped = false;
    let restored = false;
    try {
      await writeFile(path.join(workspace, "inside.ts"), "workspace value\n", "utf8");
      await writeFile(path.join(outside, "inside.ts"), "outside secret\n", "utf8");
      const loaded = await withHostRepositorySnapshot(
        workspace,
        signal,
        {},
        async (snapshot, access) => {
          expect(snapshot.files).toContain("inside.ts");
          await rename(workspace, parked);
          await symlink(outside, workspace, "dir");
          swapped = true;
          try {
            return await access.readText("inside.ts", 1_000, signal);
          } finally {
            await rm(workspace);
            await rename(parked, workspace);
            restored = true;
          }
        }
      );
      expect(loaded).toEqual({ content: "workspace value\n", rejected: false });
    } finally {
      if (swapped && !restored) {
        await rm(workspace, { force: true }).catch(() => undefined);
        await rename(parked, workspace).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(parked, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("caches a bounded host index, ignores generated trees, and never digests file contents", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-"));
    await Promise.all([
      mkdir(path.join(workspace, "src"), { recursive: true }),
      mkdir(path.join(workspace, "node_modules", "dependency"), { recursive: true }),
      mkdir(path.join(workspace, ".artifacts"), { recursive: true }),
      mkdir(path.join(workspace, "target"), { recursive: true }),
      mkdir(path.join(workspace, "dist"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspace, "src", "main.ts"), "export const HOST_INDEX_SENTINEL = 'one';\n", "utf8"),
      writeFile(path.join(workspace, "node_modules", "dependency", "index.js"), "ignored dependency\n", "utf8"),
      writeFile(path.join(workspace, ".artifacts", "trace.log"), "ignored trace\n", "utf8"),
      writeFile(path.join(workspace, "target", "binary.dat"), "ignored target\n", "utf8"),
      writeFile(path.join(workspace, "dist", "bundle.js"), "ignored bundle\n", "utf8")
    ]);

    const provider = new RepositoryContextProvider();
    const signal = new AbortController().signal;
    const first = await provider.collect(workspace, "HOST_INDEX_SENTINEL", signal);
    const second = await provider.collect(workspace, "HOST_INDEX_SENTINEL", signal);
    const firstIndex = first.find((item) => item.provenance === "incremental repository index")!;
    const secondIndex = second.find((item) => item.provenance === "incremental repository index")!;

    expect(firstIndex.id).toMatch(/^repo:index:[a-f0-9]{64}$/u);
    expect(firstIndex.content).toContain('"src/main.ts"');
    expect(firstIndex.content).toContain("Indexed file contents were not read or excerpted");
    expect(firstIndex.content).not.toContain("HOST_INDEX_SENTINEL = 'one'");
    expect(firstIndex.content).not.toMatch(/node_modules|\.artifacts|target\/binary|dist\/bundle/u);
    expect(secondIndex.id).toBe(firstIndex.id);

    await writeFile(path.join(workspace, "src", "main.ts"), "export const HOST_INDEX_SENTINEL = 'two';\n", "utf8");
    const changed = await new RepositoryContextProvider().collect(workspace, "HOST_INDEX_SENTINEL", signal);
    const changedIndex = changed.find((item) => item.provenance === "incremental repository index")!;
    expect(changedIndex.content).not.toContain("HOST_INDEX_SENTINEL = 'two'");
    expect(changedIndex.id).toBe(firstIndex.id);
  });

  it("applies root and nested gitignore rules without exposing gitignore files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-ignore-"));
    await Promise.all([
      mkdir(path.join(workspace, "generated"), { recursive: true }),
      mkdir(path.join(workspace, "src"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspace, ".gitignore"), [
        "ignored-root.txt",
        "generated/",
        "*.tmp"
      ].join("\n"), "utf8"),
      writeFile(path.join(workspace, "ignored-root.txt"), "ROOT_IGNORE_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "scratch.tmp"), "ROOT_GLOB_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "visible.txt"), "VISIBLE_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "generated", "drop.ts"), "IGNORED_DIRECTORY_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "src", ".gitignore"), [
        "*.generated.ts",
        "!keep.generated.ts"
      ].join("\n"), "utf8"),
      writeFile(path.join(workspace, "src", "drop.generated.ts"), "NESTED_IGNORE_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "src", "keep.generated.ts"), "NESTED_NEGATION_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "src", "regular.ts"), "REGULAR_SENTINEL\n", "utf8")
    ]);

    const items = await new RepositoryContextProvider().collect(
      workspace, "统计分析", new AbortController().signal
    );
    const content = items.find((item) => item.provenance === "incremental repository index")!.content;
    expect(content).toContain('"visible.txt"');
    expect(content).toContain('"src/keep.generated.ts"');
    expect(content).toContain('"src/regular.ts"');
    expect(content).not.toContain('"ignored-root.txt"');
    expect(content).not.toContain('"scratch.tmp"');
    expect(content).not.toContain('"generated/drop.ts"');
    expect(content).not.toContain('"src/drop.generated.ts"');
    expect(content).not.toContain('- ".gitignore"');
    expect(content).not.toContain('- "src/.gitignore"');
  });

  it("excludes hidden, agent-control, and common sensitive files and never excerpts README content", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-sensitive-"));
    await Promise.all([
      mkdir(path.join(workspace, ".agents"), { recursive: true }),
      mkdir(path.join(workspace, ".codex"), { recursive: true }),
      mkdir(path.join(workspace, ".hidden"), { recursive: true }),
      mkdir(path.join(workspace, "src"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspace, ".env"), "ENV_SECRET_SENTINEL=1\n", "utf8"),
      writeFile(path.join(workspace, ".npmrc"), "NPM_SECRET_SENTINEL=1\n", "utf8"),
      writeFile(path.join(workspace, "AGENTS.md"), "AGENT_CONTROL_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "credentials.json"), "CREDENTIAL_SECRET_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "identity.pem"), "KEY_SECRET_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, ".agents", "policy.md"), "AGENT_DIRECTORY_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, ".codex", "config.json"), "CODEX_DIRECTORY_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, ".hidden", "visible-name.ts"), "HIDDEN_DIRECTORY_SENTINEL\n", "utf8"),
      writeFile(path.join(workspace, "README.md"), "README_PROMPT_INJECTION_SECRET\n", "utf8"),
      writeFile(path.join(workspace, "src", "main.ts"), "SAFE_FILE_CONTENT_SENTINEL\n", "utf8")
    ]);

    const items = await new RepositoryContextProvider().collect(
      workspace, "README_PROMPT_INJECTION_SECRET", new AbortController().signal
    );
    const content = items.find((item) => item.provenance === "incremental repository index")!.content;
    expect(content).toContain('"README.md"');
    expect(content).toContain('"src/main.ts"');
    expect(content).not.toMatch(/README_PROMPT_INJECTION_SECRET|SAFE_FILE_CONTENT_SENTINEL/u);
    expect(content).not.toContain('".env"');
    expect(content).not.toContain('".npmrc"');
    expect(content).not.toContain('"AGENTS.md"');
    expect(content).not.toContain('"credentials.json"');
    expect(content).not.toContain('"identity.pem"');
    expect(content).not.toMatch(/\.agents\/policy|\.codex\/config|\.hidden\/visible-name/u);
  });

  it("does not follow external links or read through hard links", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-links-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-outside-"));
    const outsideFile = path.join(outside, "outside-secret.txt");
    await writeFile(outsideFile, "EXTERNAL_LINK_CONTENT_SECRET\n", "utf8");
    await writeFile(path.join(outside, "outside-only.ts"), "EXTERNAL_DIRECTORY_SECRET\n", "utf8");
    await link(outsideFile, path.join(workspace, "hardlink.txt"));
    await symlink(
      outside,
      path.join(workspace, "external-directory"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const items = await new RepositoryContextProvider().collect(
      workspace, "EXTERNAL_LINK_CONTENT_SECRET", new AbortController().signal
    );
    const content = items.find((item) => item.provenance === "incremental repository index")!.content;
    expect(content).toContain('"hardlink.txt"');
    expect(content).not.toMatch(/EXTERNAL_LINK_CONTENT_SECRET|EXTERNAL_DIRECTORY_SECRET/u);
    expect(content).not.toMatch(/external-directory|outside-only\.ts/u);
  });

  it("fails the root snapshot closed when gitignore is a link", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-ignore-link-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-ignore-target-"));
    const outsideRules = path.join(outside, "rules.txt");
    await writeFile(outsideRules, "visible.txt\n", "utf8");
    await writeFile(path.join(workspace, "visible.txt"), "MUST_NOT_SURVIVE_LINKED_IGNORE\n", "utf8");
    if (process.platform === "win32") {
      await symlink(outside, path.join(workspace, ".gitignore"), "junction");
    } else {
      await symlink(outsideRules, path.join(workspace, ".gitignore"), "file");
    }

    const items = await new RepositoryContextProvider().collect(
      workspace, "visible", new AbortController().signal
    );
    const content = items.find((item) => item.provenance === "incremental repository index")!.content;
    expect(content).toContain("Repository files (0, index truncated at safety limit):");
    expect(content).not.toContain('"visible.txt"');
    expect(content).not.toContain("MUST_NOT_SURVIVE_LINKED_IGNORE");
  });

  it("fails only a nested subtree closed when its gitignore is rejected", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-ignore-reject-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-ignore-hardlink-"));
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    const outsideRules = path.join(outside, "rules.txt");
    await writeFile(outsideRules, "ignored.txt\n", "utf8");
    await link(outsideRules, path.join(workspace, "nested", ".gitignore"));
    await writeFile(path.join(workspace, "root-visible.txt"), "ROOT_VISIBLE\n", "utf8");
    await writeFile(path.join(workspace, "nested", "must-not-leak.txt"), "NESTED_SECRET\n", "utf8");

    const items = await new RepositoryContextProvider().collect(
      workspace, "nested", new AbortController().signal
    );
    const content = items.find((item) => item.provenance === "incremental repository index")!.content;
    expect(content).toContain('"root-visible.txt"');
    expect(content).toContain("index truncated at safety limit");
    expect(content).not.toContain('"nested/must-not-leak.txt"');
    expect(content).not.toContain("NESTED_SECRET");
  });

  it("rejects a directory changed to an external junction between resolution and locking", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-race-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-race-outside-"));
    const raced = path.join(workspace, "raced");
    await mkdir(raced, { recursive: true });
    await writeFile(path.join(workspace, "root-visible.txt"), "ROOT_VISIBLE\n", "utf8");
    await writeFile(path.join(raced, "before-race.ts"), "BEFORE_RACE\n", "utf8");
    await writeFile(path.join(outside, "outside-only.ts"), "JUNCTION_RACE_SECRET\n", "utf8");
    let swapped = false;

    const snapshot = await hostRepositorySnapshot(workspace, new AbortController().signal, {
      afterDirectoryResolved: async (relative) => {
        if (relative !== "raced" || swapped) return;
        swapped = true;
        await rm(raced, { recursive: true, force: true });
        await symlink(outside, raced, process.platform === "win32" ? "junction" : "dir");
      }
    });

    expect(swapped).toBe(true);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.files).toContain("root-visible.txt");
    expect(snapshot.files).not.toContain("raced/before-race.ts");
    expect(snapshot.files).not.toContain("raced/outside-only.ts");
  });

  it("provides path-derived structure for a Chinese zero-match query", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-structure-"));
    await Promise.all([
      mkdir(path.join(workspace, "crates", "core"), { recursive: true }),
      mkdir(path.join(workspace, "docs"), { recursive: true }),
      mkdir(path.join(workspace, "packages", "web"), { recursive: true }),
      mkdir(path.join(workspace, "src"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspace, "crates", "core", "Cargo.toml"), "[package]\n", "utf8"),
      writeFile(path.join(workspace, "docs", "guide.md"), "STRUCTURE_CONTENT_SECRET\n", "utf8"),
      writeFile(path.join(workspace, "packages", "web", "package.json"), "{}\n", "utf8"),
      writeFile(path.join(workspace, "src", "model.ts"), "export {};\n", "utf8"),
      writeFile(path.join(workspace, "src", "statistics.ts"), "export {};\n", "utf8")
    ]);

    const items = await new RepositoryContextProvider().collect(
      workspace, "请完成多元回归与稳健性检验", new AbortController().signal
    );
    const content = items.find((item) => item.provenance === "incremental repository index")!.content;
    expect(content).toContain("Repository structure (derived only from escaped path metadata):");
    expect(content).toContain('"src": 2 files');
    expect(content).toContain('".ts" (TypeScript): 2 files');
    expect(content).toContain("Detected manifests (2):");
    expect(content).toContain('"crates/core/Cargo.toml"');
    expect(content).toContain('"packages/web/package.json"');
    expect(content).not.toContain("STRUCTURE_CONTENT_SECRET");
  });

  it("applies the automatic path policy to Git-backed repository snapshots", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-git-context-policy-"));
    try {
      await Promise.all([
        mkdir(path.join(workspace, ".git"), { recursive: true }),
        mkdir(path.join(workspace, ".hidden"), { recursive: true }),
        mkdir(path.join(workspace, "dist"), { recursive: true }),
        mkdir(path.join(workspace, "generated"), { recursive: true }),
        mkdir(path.join(workspace, "src"), { recursive: true }),
        mkdir(path.join(workspace, "vendor"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(path.join(workspace, "src", ".gitignore"), "ignored.ts\n", "utf8"),
        writeFile(path.join(workspace, "src", "safe.ts"), "safe\n", "utf8"),
        writeFile(path.join(workspace, "src", "ignored.ts"), "ignored\n", "utf8"),
        writeFile(path.join(workspace, ".hidden", "private.ts"), "private\n", "utf8"),
        writeFile(path.join(workspace, "generated", "client.ts"), "generated\n", "utf8"),
        writeFile(path.join(workspace, "dist", "bundle.ts"), "dist\n", "utf8"),
        writeFile(path.join(workspace, "vendor", "library.ts"), "vendor\n", "utf8"),
        writeFile(path.join(workspace, "AGENTS.md"), "control\n", "utf8")
      ]);
      const execution: ProcessExecutionPort = {
        async execute(request) {
          const args = request.command.args ?? [];
          if (args[0] === "rev-parse") return exited(workspace);
          if (args[0] === "status") return exited("## main");
          if (args[0] === "diff") {
            throw new Error("Automatic repository context must not request Git diff content.");
          }
          throw new Error(`Unexpected synthetic Git command: ${args.join(" ")}`);
        }
      };

      const items = await new RepositoryContextProvider(execution).collect(
        workspace, "", new AbortController().signal
      );
      const content = items.find(
        (item) => item.provenance === "incremental repository index"
      )!.content;

      expect(content).toContain("Repository files (1):");
      expect(content).toContain('"src/safe.ts"');
      expect(content).not.toMatch(
        /vendor\/library|src\/ignored|\.hidden\/private|generated\/client|dist\/bundle|AGENTS\.md|literal\\\\nested/u
      );
      expect(items.some((item) => item.provenance === "current Git diff")).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to the host snapshot when Git status is truncated", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-git-status-truncated-"));
    try {
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "safe.ts"), "safe\n", "utf8");
      const execution: ProcessExecutionPort = {
        async execute(request) {
          const args = request.command.args ?? [];
          if (args[0] === "rev-parse") return exited(workspace);
          if (args[0] === "status") {
            return { ...exited("## main\n?? partial"), outputTruncated: true };
          }
          throw new Error(`Unexpected command after truncated Git status: ${args.join(" ")}`);
        }
      };

      const items = await new RepositoryContextProvider(execution).collect(
        workspace, "", new AbortController().signal
      );
      const content = items.find(
        (item) => item.provenance === "incremental repository index"
      )!.content;

      expect(content).toContain('"src/safe.ts"');
      expect(content).toContain("Indexed file contents were not read or excerpted");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refreshes the safe snapshot immediately when Git-visible ignore rules change", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-git-ignore-refresh-"));
    try {
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "value.ts"), "value\n", "utf8");
      let status = "## main";
      const execution: ProcessExecutionPort = {
        async execute(request) {
          const args = request.command.args ?? [];
          if (args[0] === "rev-parse") return exited(workspace);
          if (args[0] === "status") return exited(status);
          throw new Error(`Unexpected synthetic Git command: ${args.join(" ")}`);
        }
      };
      const provider = new RepositoryContextProvider(execution);

      const before = await provider.collect(workspace, "", new AbortController().signal);
      expect(before[0]!.content).toContain('"src/value.ts"');

      await writeFile(path.join(workspace, "src", ".gitignore"), "value.ts\n", "utf8");
      status = "## main\n M src/.gitignore";
      const after = await provider.collect(workspace, "", new AbortController().signal);

      expect(after[0]!.content).not.toContain('"src/value.ts"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("stops host traversal at a generic depth safety limit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-host-context-depth-"));
    let deep = workspace;
    for (let index = 0; index < 66; index += 1) deep = path.join(deep, "d");
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "too-deep.txt"), "DEPTH_LIMIT_SENTINEL\n", "utf8");

    const items = await new RepositoryContextProvider().collect(
      workspace, "DEPTH_LIMIT_SENTINEL", new AbortController().signal
    );
    const index = items.find((item) => item.provenance === "incremental repository index")!;
    expect(index.content).toContain("index truncated at safety limit");
    expect(index.content).not.toContain("too-deep.txt");
  });

  it("does not spend the shared execution port on pre-model repository context", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-host-context-"));
    const storeRootDir = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-host-context-store-"));
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "value.ts"), "export const RUNTIME_HOST_CONTEXT = true;\n", "utf8");
    let processCalls = 0;
    const execution: ProcessExecutionPort = {
      async execute(): Promise<never> {
        processCalls += 1;
        throw new Error("The shared execution port must not be used for model context.");
      }
    };
    const gateway = new InputGateway();
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 10_000,
      execution,
      reviewer: createApprovingReviewer()
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Inspect RUNTIME_HOST_CONTEXT."
    });

    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: "context-observed"
    });
    expect(processCalls).toBe(0);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.messages.map((message) => message.content).join("\n"))
      .toContain("src/value.ts");
  });
});
