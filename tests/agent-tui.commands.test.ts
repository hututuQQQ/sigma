import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalCommandInput,
  commandSuggestions,
  renderCommandPalette,
  resolveCommand
} from "../packages/agent-tui/src/components/commands.js";
import { renderFileMentionPalette } from "../packages/agent-tui/src/render/palette.js";
import {
  activeFileMention,
  fileMentionSuggestions,
  insertFileMention
} from "../packages/agent-tui/src/file-mentions.js";
import { assertWithinWidth } from "../packages/agent-tui/src/ui/layout.js";
import {
  listWorkspaceEntries,
  resolveLocalTerminalInput,
  resolveLocalWorkspaceInput,
  SHELL_COMMAND_HINT
} from "../packages/agent-tui/src/workspace-command.js";

describe("agent-tui commands and mention palettes", () => {
  it("resolves aliases to canonical commands", () => {
    expect(resolveCommand("/dp")?.spec.name).toBe("/diff patch");
    expect(resolveCommand("/ds")?.spec.name).toBe("/diff stat");
    expect(resolveCommand("/q")?.spec.name).toBe("/exit");
    expect(resolveCommand("/f")?.spec.name).toBe("/files");
    expect(resolveCommand("/w packages")).toMatchObject({
      canonicalInput: "/workspace",
      value: "packages"
    });
    expect(resolveCommand("!pnpm test")).toMatchObject({
      canonicalInput: "/shell",
      value: "pnpm test"
    });
    expect(canonicalCommandInput("/h")).toBe("/help");
  });

  it("filters command suggestions by prefix and renders aliases", () => {
    expect(commandSuggestions("/di").map((command) => command.name)).toEqual([
      "/diff",
      "/diff stat",
      "/diff patch"
    ]);
    const palette = renderCommandPalette("/d", 80).join("\n");
    expect(palette).toContain("\u203a /diff");
    expect(palette).toContain("/dp");
    expect(palette).toContain("/ds");
    expect(palette).toContain("inspect");
  });

  it("parses and inserts @ file mentions", () => {
    const mention = activeFileMention("open @src/ap", "open @src/ap".length);
    expect(mention).toMatchObject({ prefix: "src/ap" });

    const suggestions = fileMentionSuggestions([
      "src/app.tsx",
      "src/render/screen.ts",
      "README.md"
    ], "src/ap");
    expect(suggestions[0]?.path).toBe("src/app.tsx");

    if (!mention) throw new Error("mention missing");
    expect(insertFileMention("open @src/ap", mention, "src/app.tsx")).toEqual({
      text: "open @src/app.tsx",
      cursor: "open @src/app.tsx".length
    });

    const palette = renderFileMentionPalette("src/", [
      { path: "src/app.tsx", score: 100 },
      { path: "src/render/screen-with-a-very-long-name.ts", score: 80 }
    ], 28, 4, false);
    expect(palette).toContain("\u203a src/app.tsx");
    expect(palette).toContain("Space selects");
    expect(assertWithinWidth(palette, 28)).toBe(true);
  });

  it("classifies cd as a local workspace switch before model submission", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tui-"));
    try {
      const child = path.join(root, "child");
      fs.mkdirSync(child);

      const result = resolveLocalWorkspaceInput("cd child", root);

      expect(result).toMatchObject({
        handled: true,
        ok: true,
        workspace: child
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies common terminal commands before model submission", () => {
    expect(resolveLocalTerminalInput("pwd")).toMatchObject({ handled: true, action: "pwd" });
    expect(resolveLocalTerminalInput("ls")).toMatchObject({ handled: true, action: "list" });
    expect(resolveLocalTerminalInput("dir")).toMatchObject({ handled: true, action: "list" });
    expect(resolveLocalTerminalInput("clear")).toMatchObject({ handled: true, action: "clear" });
    expect(resolveLocalTerminalInput("cls")).toMatchObject({ handled: true, action: "clear" });
    expect(resolveLocalTerminalInput("pnpm test")).toEqual({
      handled: true,
      action: "hint",
      message: SHELL_COMMAND_HINT
    });
    expect(resolveLocalTerminalInput("fix the tests")).toEqual({ handled: false });
  });

  it("lists workspace entries compactly with a bound", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tui-list-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "README.md"), "");
      fs.writeFileSync(path.join(root, "package.json"), "");

      const listing = listWorkspaceEntries(root, 2);

      expect(listing[0]).toBe("workspace entries (showing 2 of 3):");
      expect(listing).toContain("  src/");
      expect(listing).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
