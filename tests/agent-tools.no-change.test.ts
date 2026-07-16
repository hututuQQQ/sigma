import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, ToolExecutionContext, ToolRequest } from "../packages/agent-protocol/src/index.js";
import {
  EffectToolRegistry,
  registerBuiltinTools,
  replaceWorkspaceTextFile
} from "../packages/agent-tools/src/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-no-change-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 20
  })));
});

function context(workspacePath: string): ToolExecutionContext {
  return {
    sessionId: "no-change-session",
    runId: "no-change-run",
    workspacePath,
    runMode: "change",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
}

function request(callId: string, name: "write" | "edit", argumentsValue: JsonValue): ToolRequest {
  return { callId, name, arguments: argumentsValue };
}

describe("exact text no-change writes", () => {
  it("short-circuits the atomic text replacement before journaled mutation", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const stateRootDir = path.join(root, "state");
    await mkdir(workspace);
    const target = path.join(workspace, "same.txt");
    await writeFile(target, "same\r\n", "utf8");
    const before = await lstat(target, { bigint: true });

    const result = await replaceWorkspaceTextFile(workspace, "same.txt", {
      stateRootDir,
      transform: () => "same\r\n"
    });

    const after = await lstat(target, { bigint: true });
    expect(result).toMatchObject({
      changed: false,
      files: ["same.txt"],
      delta: { added: [], modified: [], deleted: [] }
    });
    expect({ ino: after.ino, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs })
      .toEqual({ ino: before.ino, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs });
    await expect(readFile(target, "utf8")).resolves.toBe("same\r\n");
  });

  it("normalizes an in-workspace absolute mutation path and rejects traversal", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const target = path.join(workspace, "absolute.txt");
    await writeFile(target, "before\n", "utf8");

    const result = await replaceWorkspaceTextFile(workspace, target, {
      stateRootDir: path.join(root, "state"),
      transform: () => "after\n"
    });
    expect(result.files).toEqual(["absolute.txt"]);
    await expect(readFile(target, "utf8")).resolves.toBe("after\n");

    await expect(replaceWorkspaceTextFile(workspace, path.join(workspace, "..", "escape.txt"), {
      stateRootDir: path.join(root, "state"),
      transform: () => "escape\n"
    })).rejects.toMatchObject({ code: "path_escape" });
  });

  it("reports workspace-relative paths from the write tool for absolute requests", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const target = path.join(workspace, "tool.txt");
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      atomicPatchStateRootDir: path.join(root, "state")
    });

    const result = await tools.execute(
      request("absolute-write", "write", { path: target, content: "created\n" }),
      context(workspace)
    );
    expect(result.result).toMatchObject({ status: "changed", path: "tool.txt" });
    await expect(readFile(target, "utf8")).resolves.toBe("created\n");
  });

  it("plans rollback from the first missing ancestor when write parents are missing", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      atomicPatchStateRootDir: path.join(root, "state")
    });
    const write = request("nested-write", "write", {
      path: "public/assets/site.txt",
      content: "created\n"
    });

    const plan = await tools.prepare(write, context(workspace));
    expect(plan).toMatchObject({
      writePaths: ["public/assets/site.txt"],
      checkpointScope: ["public"]
    });

    const result = await tools.execute(write, context(workspace));
    expect(result).toMatchObject({ ok: true, result: { status: "changed" } });
    await expect(readFile(path.join(workspace, "public", "assets", "site.txt"), "utf8"))
      .resolves.toBe("created\n");
  });

  it.each([
    ["write", { path: "same.txt", content: "same\n" }],
    ["edit", { path: "same.txt", oldText: "same", newText: "same" }]
  ] as const)("returns a typed no_change %s receipt without a write effect or delta", async (name, args) => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "same.txt"), "same\n", "utf8");
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      atomicPatchStateRootDir: path.join(root, "state")
    });

    const result = await tools.execute(request(`${name}-same`, name, args), context(workspace));

    expect(result).toMatchObject({
      ok: true,
      result: { status: "no_change", path: "same.txt" },
      observedEffects: ["filesystem.read"],
      actualEffects: ["filesystem.read"]
    });
    expect(result.workspaceDelta).toBeUndefined();
    expect(result.evidence).toEqual([expect.objectContaining({
      kind: "diagnostic",
      status: "informational",
      summary: expect.stringContaining("made no changes")
    })]);
  });
});
