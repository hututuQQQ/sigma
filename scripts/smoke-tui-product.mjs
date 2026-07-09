#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SmokeFakeModel } from "./smoke-fake-model.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiAppEntry = path.join(rootDir, "packages", "agent-tui", "dist", "app.js");
const composerEntry = path.join(rootDir, "packages", "agent-tui", "dist", "composer-state.js");
const agentCoreEntry = path.join(rootDir, "packages", "agent-core", "dist", "index.js");
const artifactsDir = path.join(rootDir, ".artifacts", "smoke-tui-product");
const workspace = path.join(artifactsDir, "workspace");

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawModes = [];
  }

  setRawMode(value) {
    this.rawModes.push(value);
    return this;
  }

  resume() {
    return this;
  }
}

class FakeStdout extends Writable {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 124;
    this.rows = 34;
    this.writes = [];
  }

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    callback();
  }

  write(chunk, encoding, callback) {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  }

  last() {
    return this.writes.at(-1) ?? "";
  }

  text() {
    return this.writes.join("");
  }
}

function assertBuiltTui() {
  const missing = [tuiAppEntry, composerEntry, agentCoreEntry].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Built TUI is missing. Run pnpm build first.\nMissing:\n${missing.join("\n")}`);
  }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function assertIncludes(label, text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`${label} missing expected text: ${expected}\n--- screen ---\n${text}`);
  }
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function lastPlain(stdout) {
  return stripAnsi(stdout.last());
}

async function submit(app, setComposerText, value) {
  setComposerText(app.composer, value);
  await app.submitInput();
}

function createTuiRunner(runConfiguredAgent, AgentEventBus) {
  return async (options) => {
    const eventBus = new AgentEventBus();
    const unsubscribe = eventBus.on(options.onEvent);
    try {
      const { result } = await runConfiguredAgent({
        instruction: options.instruction,
        workspacePath: options.workspacePath,
        provider: options.provider,
        model: options.model,
        modelClient: new SmokeFakeModel("create-file"),
        permissionMode: options.permissionMode,
        maxTurns: options.maxTurns,
        maxWallTimeSec: options.maxWallTimeSec,
        commandTimeoutSec: options.commandTimeoutSec,
        sandbox: options.sandbox,
        validationMode: options.validationMode,
        validationCommands: options.validationCommands,
        validationRetryLimit: options.validationRetryLimit,
        validationTimeoutSec: options.validationTimeoutSec,
        precheckCommand: options.precheckCommand,
        precheckTimeoutSec: options.precheckTimeoutSec,
        postRunCleanupGlobs: options.postRunCleanupGlobs,
        harnessTimeoutSec: options.harnessTimeoutSec,
        retryMinBudgetSec: options.retryMinBudgetSec,
        attemptsDir: options.attemptsDir,
        allowedTools: options.allowedTools,
        disabledTools: options.disabledTools,
        permissionRules: options.permissionRules,
        loopGuardMode: options.loopGuardMode,
        memoryScopes: options.memoryScopes,
        contextMode: options.contextMode ?? "repo-map",
        repoMapMaxChars: options.repoMapMaxChars,
        modelContextLimits: options.modelContextLimits,
        maxMessageHistoryChars: options.maxMessageHistoryChars,
        messageHistoryRetain: options.messageHistoryRetain,
        compactionSummaryChars: options.compactionSummaryChars,
        compactionMode: options.compactionMode,
        compactionModel: options.compactionModel,
        compactionProvider: options.compactionProvider,
        compactionMaxInputChars: options.compactionMaxInputChars,
        compactionMaxOutputChars: options.compactionMaxOutputChars,
        compactionTimeoutSec: options.compactionTimeoutSec,
        compactionFallback: options.compactionFallback,
        finalEvidenceMode: options.finalEvidenceMode,
        skillsMode: options.skillsMode,
        skillsMaxChars: options.skillsMaxChars,
        subagentsEnabled: options.subagentsEnabled,
        subagentBackgroundEnabled: options.subagentBackgroundEnabled,
        subagentHeartbeatTimeoutSec: options.subagentHeartbeatTimeoutSec,
        subagentMaxTurns: options.subagentMaxTurns,
        subagentMaxOutputChars: options.subagentMaxOutputChars,
        reviewAntiGaming: options.reviewAntiGaming,
        enableMcp: options.enableMcp,
        mcpConfig: options.mcpConfig,
        traceJsonlPath: options.traceJsonlPath,
        sessionJsonlPath: options.sessionJsonlPath,
        summaryJsonPath: options.summaryJsonPath,
        parentSessionId: options.parentSessionId,
        forkedFromSessionId: options.forkedFromSessionId,
        permissionDecider: options.permissionMode === "ask" ? options.permissionController : undefined,
        eventBus,
        abortSignal: options.abortSignal
      });
      return result;
    } finally {
      unsubscribe();
    }
  };
}

async function main() {
  assertBuiltTui();
  const previousEnv = {
    FORCE_COLOR: process.env.FORCE_COLOR,
    NO_COLOR: process.env.NO_COLOR,
    SIGMA_FORCE_UNICODE: process.env.SIGMA_FORCE_UNICODE,
    SIGMA_NO_COLOR: process.env.SIGMA_NO_COLOR,
    TERM: process.env.TERM
  };
  process.env.NO_COLOR = "1";
  process.env.SIGMA_NO_COLOR = "1";
  process.env.SIGMA_FORCE_UNICODE = "1";
  process.env.TERM = "xterm-256color";

  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Smoke workspace\n", "utf8");

  const { TuiApp, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, HIDE_CURSOR, SHOW_CURSOR } = await import(`file://${tuiAppEntry.replace(/\\/g, "/")}`);
  const { setComposerText } = await import(`file://${composerEntry.replace(/\\/g, "/")}`);
  const { AgentEventBus, runConfiguredAgent } = await import(`file://${agentCoreEntry.replace(/\\/g, "/")}`);

  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const app = new TuiApp({
    workspace,
    provider: "deepseek",
    model: "smoke-fake-model",
    permissionMode: "yolo",
    validationMode: "auto",
    finalEvidenceMode: "auto",
    traceJsonl: path.join(artifactsDir, "trace.jsonl"),
    summaryJson: path.join(artifactsDir, "summary.json"),
    sessionJsonl: path.join(artifactsDir, "session.jsonl"),
    attemptsDir: path.join(artifactsDir, "attempts")
  }, stdin, stdout, createTuiRunner(runConfiguredAgent, AgentEventBus));

  const screens = {};
  let started;
  let stopped = false;
  try {
    started = app.start();
    await Promise.resolve();
    screens.initial = lastPlain(stdout);
    assertIncludes("initial TUI screen", screens.initial, "Sigma Code v0.1.0");
    assertIncludes("initial TUI screen", screens.initial, "idle");
    assertIncludes("initial TUI screen", screens.initial, "> ");

    await submit(app, setComposerText, "Create a hello.txt file with a friendly message.");
    screens.afterRun = lastPlain(stdout);
    assertIncludes("post-run TUI screen", screens.afterRun, "Run completed.");
    assertIncludes("post-run TUI screen", screens.afterRun, "completed");
    assertIncludes("post-run TUI screen", screens.afterRun, "hello.txt");

    await submit(app, setComposerText, "/jobs");
    screens.jobs = lastPlain(stdout);
    assertIncludes("jobs TUI screen", screens.jobs, "jobs");
    assertIncludes("jobs TUI screen", screens.jobs, "run state: completed");
    assertIncludes("jobs TUI screen", screens.jobs, "session id:");
    assertIncludes("jobs TUI screen", screens.jobs, "manifest:");

    await submit(app, setComposerText, "/artifacts");
    screens.artifacts = lastPlain(stdout);
    assertIncludes("artifacts TUI screen", screens.artifacts, "artifacts");
    assertIncludes("artifacts TUI screen", screens.artifacts, "changed files: 1");
    assertIncludes("artifacts TUI screen", screens.artifacts, "final gate:");
    assertIncludes("artifacts TUI screen", screens.artifacts, "agent artifacts");

    const hello = await readFile(path.join(workspace, "hello.txt"), "utf8");
    if (!hello.includes("hello world")) {
      throw new Error(`TUI smoke did not produce hello.txt with expected content: ${hello}`);
    }

    app.stop();
    stopped = true;
    await started;

    if (!stdout.text().includes(ENTER_ALT_SCREEN) || !stdout.text().includes(EXIT_ALT_SCREEN)) {
      throw new Error("TUI smoke did not enter and exit the alternate screen.");
    }
    if (!stdout.text().includes(HIDE_CURSOR) || !stdout.text().includes(SHOW_CURSOR)) {
      throw new Error("TUI smoke did not hide and restore the cursor.");
    }
    if (stdin.rawModes.join(",") !== "true,false") {
      throw new Error(`TUI smoke raw mode transitions were unexpected: ${stdin.rawModes.join(",")}`);
    }

    const sessionMatch = screens.artifacts.match(/session id:\s+([^\s]+)/);
    const report = {
      ok: true,
      workspace,
      sessionId: sessionMatch?.[1] ?? null,
      screens: {
        initial: path.join(artifactsDir, "initial.txt"),
        afterRun: path.join(artifactsDir, "after-run.txt"),
        jobs: path.join(artifactsDir, "jobs.txt"),
        artifacts: path.join(artifactsDir, "artifacts.txt")
      },
      checks: {
        alternateScreen: true,
        cursorLifecycle: true,
        rawModeLifecycle: true,
        runCompleted: true,
        jobsPanel: true,
        artifactsPanel: true
      }
    };
    for (const [name, text] of Object.entries(screens)) {
      await writeFile(path.join(artifactsDir, `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.txt`), text, "utf8");
    }
    await writeFile(path.join(artifactsDir, "tui-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`PASS TUI product smoke session=${report.sessionId ?? "unknown"}\n`);
  } finally {
    if (started && !stopped) {
      try {
        app.stop();
        await started;
      } catch {
        // Preserve the original smoke failure.
      }
    }
    restoreEnv(previousEnv);
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
