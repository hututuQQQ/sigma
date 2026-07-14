#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fakeFinalTurn,
  fakeReviewerTurn,
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway,
  smokeRuntimeConfig
} from "../smoke-fake-model.mjs";

const packageRoot = path.resolve(process.env.SIGMA_PACKAGE_ROOT ?? "/opt/sigma");
const workspace = path.resolve(process.env.SIGMA_SMOKE_WORKSPACE ?? "/workspace");
const stateRoot = path.resolve(process.env.SIGMA_SMOKE_STATE_ROOT ?? "/tmp/sigma-package-smoke-state");
export const linuxPackageFakeModelSmokeScript = fileURLToPath(import.meta.url);

function currentRunWorkspaceDelta(request) {
  const ledger = [...request.messages].reverse().find((message) =>
    message.content.includes("Current-run typed durable evidence ledger."))?.content ?? "";
  return [...ledger.matchAll(/^- (.+?) \(([^,]+), [^)]+\)$/gmu)]
    .map((match) => ({ evidenceId: match[1], kind: match[2] }))
    .findLast((item) => item.kind === "workspace_delta");
}

function realSandboxValidationTurn(request) {
  const delta = currentRunWorkspaceDelta(request);
  if (!delta) throw new Error("The package smoke requires current-run workspace delta evidence.");
  return fakeToolTurn([fakeToolCall("validate-package-smoke", "validate", {
    executable: "node",
    args: [
      "-e",
      "const fs=require('node:fs');process.exit(fs.readFileSync('hello.txt','utf8')==='hello from package\\n'?0:1)"
    ],
    access: "readonly",
    workspaceDeltaEvidenceIds: [delta.evidenceId]
  })]);
}

export async function runLinuxPackageFakeModelSmoke() {
  const [{ runAgentCommand }, { createConfiguredRuntime }] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, "packages", "agent-cli", "dist", "index.js")).href),
    import(pathToFileURL(path.join(packageRoot, "packages", "agent-runtime", "dist", "index.js")).href)
  ]);

  const initCode = await runAgentCommand([
    "init", "--workspace", workspace, "--permission-mode", "auto"
  ]);
  if (initCode !== 0) throw new Error(`agent init failed with exit ${initCode}`);

  const gateway = new SmokeFakeGateway([
    fakeToolTurn([fakeToolCall("write-package-smoke", "write", {
      path: "hello.txt", content: "hello from package\n"
    })]),
    realSandboxValidationTurn,
    fakeReviewerTurn(),
    fakeFinalTurn("Portable package fake-model smoke completed.")
  ]);
  const composition = await createConfiguredRuntime(smokeRuntimeConfig(workspace), {
    gatewayFactory: () => gateway,
    stateRootDir: stateRoot
  }, { connectMcp: false });
  try {
    const session = await composition.runtime.createSession({
      workspacePath: workspace,
      mode: "change",
      title: "portable package fake-model smoke"
    });
    const events = [];
    const subscriptionController = new AbortController();
    const subscribed = (async () => {
      try {
        for await (const event of composition.runtime.subscribe(
          session.sessionId,
          subscriptionController.signal
        )) events.push(event);
      } catch (error) {
        if (!subscriptionController.signal.aborted) throw error;
      }
    })();
    await composition.runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Create hello.txt and validate it.",
      mode: "change"
    });
    const outcome = await composition.runtime.waitForOutcome(session.sessionId);
    subscriptionController.abort();
    await subscribed;
    if (outcome.kind !== "completed") {
      throw new Error(
        `runtime outcome was ${JSON.stringify(outcome)}; requests=${gateway.requests.length}; `
        + `events=${JSON.stringify(events)}`
      );
    }
    if (await readFile(path.join(workspace, "hello.txt"), "utf8") !== "hello from package\n") {
      throw new Error("portable package smoke file did not match");
    }
    const report = {
      ok: true,
      sessionId: session.sessionId,
      outcome: outcome.kind,
      fakeModelRequests: gateway.requests.length,
      realSandboxValidation: true
    };
    await writeFile(
      path.join(workspace, "linux-package-fake-model-smoke.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await composition.close();
  }
}

if (path.resolve(process.argv[1] ?? "") === linuxPackageFakeModelSmokeScript) {
  await runLinuxPackageFakeModelSmoke().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
