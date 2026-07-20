import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, ToolExecutionContext, ToolRequest } from "../packages/agent-protocol/src/index.js";
import {
  EffectToolRegistry,
  MAX_EXPLICIT_WORKSPACE_READ_BYTES,
  readStableWorkspaceTextFile,
  registerBuiltinTools
} from "../packages/agent-tools/src/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }));
});

function context(workspacePath: string): ToolExecutionContext {
  return {
    sessionId: "stable-read-session",
    runId: "stable-read-run",
    workspacePath,
    runMode: "analyze",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
}

function request(callId: string, args: JsonValue): ToolRequest {
  return { callId, name: "read", arguments: args };
}

describe("stable explicit workspace reads", () => {
  it("reads ordinary UTF-8 files with line pagination", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "lines.txt"), "first\nsecond\nthird\nfourth\n", "utf8");
    const tools = registerBuiltinTools(new EffectToolRegistry());

    const result = await tools.execute(
      request("page", { path: "src/lines.txt", offset: 1, limit: 2 }),
      context(workspace)
    );

    expect(result.output).toBe("2: second\n3: third");
    expect(result.observedEffects).toEqual(["filesystem.read"]);
    expect(result.evidence).toEqual([expect.objectContaining({
      kind: "input_access",
      status: "passed",
      data: expect.objectContaining({
        path: "src/lines.txt",
        scope: "workspace",
        byteLength: Buffer.byteLength("first\nsecond\nthird\nfourth\n"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        selection: {
          kind: "line_range",
          start: 1,
          endExclusive: 3,
          byteLength: Buffer.byteLength(result.output),
          sha256: createHash("sha256").update(result.output, "utf8").digest("hex")
        }
      })
    })]);

    const equivalent = await tools.execute(
      request("equivalent-page", { path: "src/./lines.txt", offset: 1, limit: 2 }),
      context(workspace)
    );
    expect(equivalent.output).toBe(result.output);
    expect(equivalent.evidence?.[0]?.data).toEqual(result.evidence?.[0]?.data);

    const pastEnd = await tools.execute(
      request("past-end", { path: "src/lines.txt", offset: 100, limit: 1 }),
      context(workspace)
    );
    const fartherPastEnd = await tools.execute(
      request("farther-past-end", { path: "src/lines.txt", offset: 10_000, limit: 500 }),
      context(workspace)
    );
    expect(pastEnd.evidence?.[0]?.data).toEqual(fartherPastEnd.evidence?.[0]?.data);
  });

  it("reads an approved absolute host input with stable input-access evidence", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-workspace-");
    const external = await temporaryDirectory("sigma-stable-read-external-");
    const inputPath = path.join(external, "input.txt");
    await writeFile(inputPath, "external input\n", "utf8");
    const tools = registerBuiltinTools(new EffectToolRegistry(), { readScope: "host" });
    const call = request("external-input", { path: inputPath });
    const plan = await tools.prepare(call, {
      sessionId: "stable-read-session", runId: "stable-read-run", workspacePath: workspace, runMode: "analyze"
    });

    expect(plan).toMatchObject({
      exactEffects: ["filesystem.read", "filesystem.read.external"],
      readPaths: [inputPath]
    });
    const result = await tools.execute(call, {
      ...context(workspace),
      callPlan: plan,
      approval: { externalReadApproved: true }
    });

    expect(result.output).toBe("1: external input");
    expect(result.evidence).toEqual([expect.objectContaining({
      kind: "input_access",
      status: "passed",
      data: expect.objectContaining({
        path: inputPath,
        scope: "external",
        byteLength: Buffer.byteLength("external input\n"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        selection: expect.objectContaining({
          kind: "line_range", start: 0, endExclusive: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        })
      })
    })]);
  });

  it("fails closed for strict workspace-only reads and missing external grants", async () => {
    const workspace = await temporaryDirectory("sigma-strict-read-workspace-");
    const external = await temporaryDirectory("sigma-strict-read-external-");
    const inputPath = path.join(external, "input.txt");
    await writeFile(inputPath, "external", "utf8");
    const strict = registerBuiltinTools(new EffectToolRegistry(), { readScope: "workspace" });
    await expect(strict.prepare(request("strict", { path: inputPath }), {
      sessionId: "stable-read-session", runId: "stable-read-run", workspacePath: workspace, runMode: "analyze"
    })).rejects.toMatchObject({ code: "policy_denied" });

    const host = registerBuiltinTools(new EffectToolRegistry(), { readScope: "host" });
    const call = request("unapproved", { path: inputPath });
    const plan = await host.prepare(call, {
      sessionId: "stable-read-session", runId: "stable-read-run", workspacePath: workspace, runMode: "analyze"
    });
    await expect(host.execute(call, { ...context(workspace), callPlan: plan }))
      .rejects.toMatchObject({ code: "per_call_approval_required" });
  });

  it("uses shared CR, LF, and CRLF line semantics without synthetic empty lines", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-lines-");
    await writeFile(path.join(workspace, "mixed.txt"), "one\rtwo\r\nthree\n", "utf8");
    await writeFile(path.join(workspace, "empty.txt"), "", "utf8");
    await writeFile(path.join(workspace, "no-newline.txt"), "tail", "utf8");
    const tools = registerBuiltinTools(new EffectToolRegistry());

    const mixed = await tools.execute(
      request("mixed-lines", { path: "mixed.txt" }), context(workspace)
    );
    const empty = await tools.execute(
      request("empty-lines", { path: "empty.txt" }), context(workspace)
    );
    const noNewline = await tools.execute(
      request("no-newline", { path: "no-newline.txt" }), context(workspace)
    );

    expect(mixed.output).toBe("1: one\n2: two\n3: three");
    expect(mixed.result).toMatchObject({
      status: "read",
      byteLength: Buffer.byteLength("one\rtwo\r\nthree\n"),
      endsWithNewline: true,
      returnedLines: 3,
      totalLines: 3
    });
    expect(empty.output).toBe("");
    expect(empty.result).toMatchObject({
      status: "read", byteLength: 0, endsWithNewline: false, returnedLines: 0, totalLines: 0
    });
    expect(noNewline.result).toMatchObject({
      status: "read", byteLength: 4, endsWithNewline: false, returnedLines: 1, totalLines: 1
    });
  });

  it("rejects external hard links, links, and non-regular files", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-");
    const external = await temporaryDirectory("sigma-stable-read-external-");
    const outside = path.join(external, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await link(outside, path.join(workspace, "hard-link.txt"));
    await expect(readStableWorkspaceTextFile(
      workspace, "hard-link.txt", new AbortController().signal
    )).rejects.toMatchObject({ code: "workspace_read_unsafe" });

    const linkedPath = process.platform === "win32" ? "symbolic-directory/outside.txt" : "symbolic-link.txt";
    await symlink(
      process.platform === "win32" ? external : outside,
      path.join(workspace, process.platform === "win32" ? "symbolic-directory" : "symbolic-link.txt"),
      process.platform === "win32" ? "junction" : "file"
    );
    await expect(readStableWorkspaceTextFile(
      workspace, linkedPath, new AbortController().signal
    )).rejects.toMatchObject({ code: "workspace_read_unsafe" });
    await mkdir(path.join(workspace, "directory"));
    await expect(readStableWorkspaceTextFile(
      workspace, "directory", new AbortController().signal
    )).rejects.toMatchObject({ code: "workspace_read_unsafe" });
  });

  it("rejects files above the explicit read byte limit", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-");
    await writeFile(
      path.join(workspace, "oversized.txt"),
      Buffer.alloc(MAX_EXPLICIT_WORKSPACE_READ_BYTES + 1, 0x61)
    );

    await expect(readStableWorkspaceTextFile(
      workspace, "oversized.txt", new AbortController().signal
    )).rejects.toMatchObject({ code: "workspace_read_too_large" });
  });

  it("keeps a pinned file bound across a parent-directory ABA swap", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-");
    const active = path.join(workspace, "active");
    const held = path.join(workspace, "held");
    const replacement = path.join(workspace, "replacement");
    await mkdir(active);
    await mkdir(replacement);
    await writeFile(path.join(active, "value.txt"), "original\n", "utf8");
    await writeFile(path.join(replacement, "value.txt"), "replacement\n", "utf8");
    let swapped = false;
    let originalMoved = false;

    const loaded = await readStableWorkspaceTextFile(
      workspace,
      "active/value.txt",
      new AbortController().signal,
      {
        beforePinnedRead: async () => {
          try {
            await rename(active, held);
            originalMoved = true;
            await rename(replacement, active);
            swapped = true;
          } catch (error) {
            if (originalMoved && !swapped) await rename(held, active);
            if (process.platform !== "win32") throw error;
          }
        },
        afterPinnedRead: async () => {
          if (!swapped) return;
          await rename(active, replacement);
          await rename(held, active);
        }
      }
    );

    expect(loaded).toMatchObject({
      content: "original\n",
      byteLength: Buffer.byteLength("original\n"),
      endsWithNewline: true
    });
    expect(loaded.bytes.equals(Buffer.from("original\n", "utf8"))).toBe(true);
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects malformed UTF-8 with a stable diagnostic code", async () => {
    const workspace = await temporaryDirectory("sigma-stable-read-");
    await writeFile(path.join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await expect(readStableWorkspaceTextFile(
      workspace, "invalid.txt", new AbortController().signal
    )).rejects.toMatchObject({ code: "workspace_read_invalid_utf8" });
  });
});
