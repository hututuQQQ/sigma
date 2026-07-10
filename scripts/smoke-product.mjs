#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeFinalTurn, fakeToolCall, fakeToolTurn, SmokeFakeGateway } from "./smoke-fake-model.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(rootDir, ".artifacts", "smoke-product");
const workspace = path.join(artifactsDir, "workspace");
process.env.SIGMA_STATE_HOME = path.join(artifactsDir, "private-state");

class Capture extends Writable {
  constructor() { super(); this.chunks = []; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); callback(); }
  text() { return Buffer.concat(this.chunks).toString("utf8"); }
}

async function captureProcessWrites(action) {
  const stdout = new Capture();
  const stderr = new Capture();
  const oldOut = process.stdout.write;
  const oldErr = process.stderr.write;
  try {
    process.stdout.write = stdout.write.bind(stdout);
    process.stderr.write = stderr.write.bind(stderr);
    return { code: await action(), stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
}

async function main() {
  const entries = ["agent-cli", "agent-runtime", "agent-store", "agent-tools", "agent-tui"]
    .map((name) => path.join(rootDir, "packages", name, "dist", "index.js"));
  const missing = entries.filter((entry) => !existsSync(entry));
  if (missing.length) throw new Error(`Built product is missing:\n${missing.join("\n")}`);
  const [{ runAgentCommand }, { createRuntime, runtimeStateRoot }, { SegmentedJsonlStore }, { EffectToolRegistry, registerBuiltinTools }] = await Promise.all([
    import(pathToFileURL(entries[0]).href),
    import(pathToFileURL(entries[1]).href),
    import(pathToFileURL(entries[2]).href),
    import(pathToFileURL(entries[3]).href)
  ]);

  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const initialized = await captureProcessWrites(() => runAgentCommand(["init", "--workspace", workspace, "--permission-mode", "auto"]));
  if (initialized.code !== 0) throw new Error(`init failed: ${initialized.stderr}`);

  const storeRootDir = runtimeStateRoot(workspace);
  const runtime = createRuntime({
    gateway: new SmokeFakeGateway([
      fakeToolTurn([fakeToolCall("write-smoke", "write", { path: "hello.txt", content: "hello world" })]),
      fakeFinalTurn("Product smoke completed.", ["write-smoke"])
    ]),
    store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
    storeRootDir,
    tools: registerBuiltinTools(new EffectToolRegistry()),
    permissionMode: "auto",
    runDeadlineMs: 30_000
  });
  const session = await runtime.createSession({ workspacePath: workspace, mode: "change", title: "product smoke" });
  await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Create hello.txt", mode: "change" });
  const outcome = await runtime.waitForOutcome(session.sessionId);
  if (outcome.kind !== "completed") throw new Error(`runtime outcome: ${JSON.stringify(outcome)}`);
  if ((await readFile(path.join(workspace, "hello.txt"), "utf8")) !== "hello world") throw new Error("hello.txt content mismatch");

  const version = await captureProcessWrites(() => runAgentCommand(["version", "--json"]));
  const doctor = await captureProcessWrites(() => runAgentCommand(["doctor", "--workspace", workspace, "--json"]));
  const sessions = await captureProcessWrites(() => runAgentCommand(["sessions", "--workspace", workspace, "--json"]));
  for (const [name, result] of Object.entries({ version, doctor, sessions })) {
    if (result.code !== 0) throw new Error(`${name} failed: ${result.stderr}`);
  }
  const sessionReport = JSON.parse(sessions.stdout);
  if (sessionReport.sessions[0]?.sessionId !== session.sessionId) throw new Error("sessions did not return the latest session");
  const report = {
    ok: true,
    sessionId: session.sessionId,
    outcome,
    version: JSON.parse(version.stdout),
    doctor: JSON.parse(doctor.stdout),
    sessions: sessionReport.sessions.length
  };
  await writeFile(path.join(artifactsDir, "product-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`PASS product smoke session=${session.sessionId}\n`);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
