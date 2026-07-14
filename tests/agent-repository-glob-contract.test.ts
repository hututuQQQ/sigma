import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listRepositoryFiles } from "../packages/agent-context/src/index.js";
import type { ToolExecutionContext, ToolRequest } from "../packages/agent-protocol/src/index.js";
import { repositoryTools } from "../packages/agent-tools/src/index.js";

function context(workspacePath: string): ToolExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath,
    runMode: "analyze",
    signal: new AbortController().signal,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
}

function request(glob: string): ToolRequest {
  return { callId: "list", name: "list", arguments: { glob } };
}

describe("repository list glob contract", () => {
  it.each([
    ["src\\*.ts", "backslash separators"],
    ["*.{ts,tsx}", "brace expansion"],
    ["[ab].ts", "character classes"],
    ["@(one|two).ts", "extended globs"],
    ["!*.md", "leading negation"]
  ])("rejects unsupported %s syntax before scanning", async (glob, construct) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-list-glob-contract-"));
    try {
      await writeFile(path.join(workspace, "visible.ts"), "export {};\n", "utf8");
      await expect(listRepositoryFiles(
        workspace,
        new AbortController().signal,
        { glob }
      )).rejects.toMatchObject({
        code: "unsupported_repository_glob_syntax",
        message: expect.stringContaining(
          `Unsupported list glob syntax: ${construct}`
        )
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a stable failed receipt for unsupported syntax", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-list-glob-tool-"));
    try {
      const list = repositoryTools(undefined, {
        list: async (root, signal, options) => {
          const listing = await listRepositoryFiles(root, signal, options);
          return { output: listing.entries.map((entry) => JSON.stringify(entry)).join("\n") };
        }
      })
        .find((tool) => tool.descriptor.name === "list");
      const receipt = await list!.execute(request("src\\*.ts"), context(workspace));

      expect(receipt).toMatchObject({
        ok: false,
        output: "Unsupported list glob syntax: backslash separators; use literals, '/', '*', '?', and '**'.",
        diagnostics: ["unsupported_repository_glob_syntax"]
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
