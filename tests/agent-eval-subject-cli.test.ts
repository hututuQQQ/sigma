import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCliSubject } from "../scripts/eval/subject-cli.mjs";
import { createDevNodeLaunch } from "../scripts/eval/subject-launch.mjs";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("evaluation CLI subject lifecycle", () => {
  it("cancels a real process at the external wall budget and waits for the cancel helper to exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-subject-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const artifactDir = path.join(root, "artifacts");
    const stateHome = path.join(root, "state");
    await Promise.all([mkdir(workspace), mkdir(artifactDir), mkdir(stateHome)]);
    const promptPath = path.join(root, "prompt.md");
    await writeFile(promptPath, "wait\n", "utf8");
    const subjectPath = path.join(root, "fake-subject.mjs");
    await writeFile(subjectPath, `
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const workspaceIndex = args.indexOf("--workspace");
const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.cwd();
const signal = path.join(workspace, "cancel.signal");
if (args[0] === "session" && args[1] === "cancel") {
  writeFileSync(signal, "requested");
  setTimeout(() => {
    writeFileSync(path.join(workspace, "cancel.finished"), "finished");
    process.exit(0);
  }, 150);
} else {
  let seq = 0;
  const emit = (type, payload = {}) => console.log(JSON.stringify({ kind: "event", event: {
    schemaVersion: 3, seq: ++seq, eventId: "event-" + seq, sessionId: "fake-session", runId: "fake-run",
    occurredAt: new Date().toISOString(), type, authority: "runtime", payload
  }}));
  emit("run.started", { mode: "change" });
  emit("model.started", { turnId: 1, effectRevision: 1 });
  const timer = setInterval(() => {
    if (!existsSync(signal)) return;
    clearInterval(timer);
    emit("run.cancelled", { reason: "external budget" });
    process.exit(0);
  }, 10);
}
`, "utf8");

    const result = await runCliSubject({
      workspace,
      stateHome,
      promptPath,
      runMode: "change",
      env: process.env,
      budget: { wallTimeSec: 0.05, modelTurns: 8, toolCalls: 12, costUsd: 0.1 },
      artifactDir,
      redactor: String,
      subject: {
        subjectKind: "dev",
        nodePath: process.execPath,
        cliEntry: subjectPath,
        launch: createDevNodeLaunch(process.execPath, subjectPath)
      }
    });

    expect(result.cancellation).toMatchObject({ reason: "experience_budget_exceeded", dimension: "wallTime", cancelExitCode: 0 });
    expect(result.events.some((event: { type: string }) => event.type === "run.cancelled")).toBe(true);
    await expect(access(path.join(workspace, "cancel.finished"))).resolves.toBeUndefined();
  });
});
