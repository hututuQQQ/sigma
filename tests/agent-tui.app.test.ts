import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../packages/agent-core/src/index.js";
import { TuiApp, HIDE_CURSOR, SHOW_CURSOR, type TuiAppOptions, type TuiSessionRunner } from "../packages/agent-tui/src/app.js";
import { setComposerText, type ComposerState } from "../packages/agent-tui/src/composer-state.js";
import { SHELL_COMMAND_HINT } from "../packages/agent-tui/src/workspace-command.js";

const savedEnv = {
  SIGMA_ASCII: process.env.SIGMA_ASCII,
  SIGMA_FORCE_UNICODE: process.env.SIGMA_FORCE_UNICODE,
  TERM: process.env.TERM
};

class FakeStdin extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];

  setRawMode(value: boolean): this {
    this.rawModes.push(value);
    return this;
  }

  resume(): this {
    return this;
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  writes: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk));
    return true;
  }

  text(): string {
    return this.writes.join("");
  }

  last(): string {
    return this.writes.at(-1) ?? "";
  }
}

function options(workspace: string): TuiAppOptions {
  return {
    workspace,
    provider: "deepseek",
    permissionMode: "ask"
  };
}

function runnerSpy(): { runner: TuiSessionRunner; calls: { instruction: string }[] } {
  const calls: { instruction: string }[] = [];
  const result: AgentRunResult = {
    status: "completed",
    finishReason: "assistant_stop",
    toolCalls: 0,
    turns: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 }
  };
  return {
    calls,
    runner: async (runOptions) => {
      calls.push({ instruction: runOptions.instruction });
      return result;
    }
  };
}

function testable(app: TuiApp): { composer: ComposerState; submitInput(): Promise<void> } {
  return app as unknown as { composer: ComposerState; submitInput(): Promise<void> };
}

async function submit(app: TuiApp, input: string): Promise<void> {
  const target = testable(app);
  setComposerText(target.composer, input);
  await target.submitInput();
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent-tui app lifecycle and local terminal input", () => {
  it("hides the native cursor on start/render and restores it on stop", async () => {
    process.env.SIGMA_FORCE_UNICODE = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tui-life-"));
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const { runner } = runnerSpy();
    const app = new TuiApp(options(root), stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, runner);
    try {
      const started = app.start();
      await Promise.resolve();

      expect(stdout.writes[0]).toBe(HIDE_CURSOR);
      expect(stdout.text()).toContain(`${HIDE_CURSOR}\x1b[2J\x1b[H`);

      stdin.emit("keypress", "", { ctrl: true, name: "c" });
      await started;

      expect(stdout.last()).toContain(SHOW_CURSOR);
      expect(stdin.rawModes).toEqual([true, false]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the compact logo lockup in help", async () => {
    process.env.SIGMA_FORCE_UNICODE = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tui-help-"));
    const stdout = new FakeStdout();
    const { runner, calls } = runnerSpy();
    const app = new TuiApp(options(root), new FakeStdin() as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, runner);
    try {
      await submit(app, "/help");

      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain("\u2211 Sigma");
      expect(stdout.last()).toContain("sum the repo \u00b7 ship the patch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles pwd, ls, dir, clear, and cls without calling the model", async () => {
    process.env.SIGMA_FORCE_UNICODE = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tui-local-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "README.md"), "");
    const stdout = new FakeStdout();
    const { runner, calls } = runnerSpy();
    const app = new TuiApp(options(root), new FakeStdin() as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, runner);
    try {
      await submit(app, "pwd");
      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain(`workspace: ${root}`);

      await submit(app, "ls");
      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain("workspace entries");
      expect(stdout.last()).toContain("src/");

      await submit(app, "dir");
      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain("README.md");

      await submit(app, "clear");
      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain("Ready in");
      expect(stdout.last()).not.toContain("workspace entries");

      await submit(app, "pwd");
      await submit(app, "cls");
      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain("Ready in");
      expect(stdout.last()).not.toContain(`workspace: ${root}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows a shell hint for shell-like input without calling the model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tui-shell-hint-"));
    const stdout = new FakeStdout();
    const { runner, calls } = runnerSpy();
    const app = new TuiApp(options(root), new FakeStdin() as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, runner);
    try {
      await submit(app, "pnpm test");

      expect(calls).toHaveLength(0);
      expect(stdout.last()).toContain(SHELL_COMMAND_HINT);
      expect(stdout.last()).not.toContain("Missing DEEPSEEK_API_KEY");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
