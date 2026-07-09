#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeFinalTurn, fakeToolCall, fakeToolTurn, SmokeFakeGateway } from "./smoke-fake-model.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(rootDir, ".artifacts", "smoke-tui-product");
const workspace = path.join(artifactsDir, "workspace");

class FakeInput extends PassThrough {
  constructor() { super(); this.isTTY = true; this.rawModes = []; }
  setRawMode(mode) { this.rawModes.push(mode); return this; }
}

class FakeOutput extends Writable {
  constructor() { super(); this.columns = 100; this.rows = 30; this.chunks = []; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); callback(); }
  text() { return Buffer.concat(this.chunks).toString("utf8"); }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("TUI smoke timed out.");
}

async function main() {
  const entries = ["agent-tui", "agent-runtime", "agent-store", "agent-tools"]
    .map((name) => path.join(rootDir, "packages", name, "dist", "index.js"));
  const missing = entries.filter((entry) => !existsSync(entry));
  if (missing.length) throw new Error(`Built TUI product is missing:\n${missing.join("\n")}`);
  const [{ TuiController }, { createRuntime }, { SegmentedJsonlStore }, { EffectToolRegistry, registerBuiltinTools }] = await Promise.all(entries.map((entry) => import(pathToFileURL(entry).href)));
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const storeRootDir = path.join(workspace, ".agent");
  const runtime = createRuntime({
    gateway: new SmokeFakeGateway([
      fakeToolTurn([fakeToolCall("write-smoke", "write", { path: "hello.txt", content: "hello world" })]),
      fakeFinalTurn("TUI smoke completed.", ["write-smoke"])
    ]),
    store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
    storeRootDir,
    tools: registerBuiltinTools(new EffectToolRegistry()),
    permissionMode: "auto",
    runDeadlineMs: 30_000
  });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const controller = new TuiController({ runtime, workspace, stdin, stdout, maxFps: 30 });
  const running = controller.run();
  await new Promise((resolve) => setTimeout(resolve, 30));
  stdin.write("Create hello.txt\r");
  await waitUntil(() => Promise.resolve(existsSync(path.join(workspace, "hello.txt"))));
  await waitUntil(async () => (await runtime.listSessions(1))[0]?.status === "completed");
  stdout.columns = 20;
  stdout.rows = 5;
  stdout.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write("/quit\r");
  await running;

  const terminal = stdout.text();
  if (!terminal.includes("\u001b[?1049h") || !terminal.includes("\u001b[?1049l")) throw new Error("Alternate-screen lifecycle was incomplete.");
  if (!terminal.includes("\u001b[?25l") || !terminal.includes("\u001b[?25h")) throw new Error("Cursor lifecycle was incomplete.");
  if (stdin.rawModes.join(",") !== "true,false") throw new Error(`Raw-mode lifecycle was ${stdin.rawModes.join(",")}`);
  if ((await readFile(path.join(workspace, "hello.txt"), "utf8")) !== "hello world") throw new Error("TUI run produced the wrong file.");
  const latest = (await runtime.listSessions(1))[0];
  const report = {
    ok: true,
    sessionId: latest?.sessionId ?? null,
    rawModes: stdin.rawModes,
    resizedTo: [stdout.columns, stdout.rows],
    terminalBytes: Buffer.byteLength(terminal),
    checks: { alternateScreen: true, cursorLifecycle: true, rawModeLifecycle: true, runCompleted: latest?.status === "completed", resize: true }
  };
  await writeFile(path.join(artifactsDir, "tui-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write("PASS TUI product smoke\n");
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
