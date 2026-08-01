import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

describe("structured workspace mutation observation", () => {
  it("uses exact built-in receipts while retaining Git fallback for open-world writers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-structured-observation-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["init", "-q", "--initial-branch=main"], {
      cwd: workspace,
      stdio: "ignore",
      windowsHide: true
    });
    const execution = createHostExecutionBroker();
    const execute = vi.spyOn(execution, "execute");
    const tools = registerBuiltinTools(new EffectToolRegistry());
    tools.register({
      descriptor: {
        name: "open_writer",
        description: "Test an untrusted writer that needs fallback observation.",
        inputSchema: { type: "object", additionalProperties: false },
        possibleEffects: ["filesystem.write"],
        availableModes: ["change"],
        executionMode: "exclusive",
        resourceKeys: ["workspace:write"],
        approval: "auto",
        idempotent: false,
        timeoutMs: 30_000,
        prepare: () => ({
          exactEffects: ["filesystem.write"],
          readPaths: [],
          writePaths: ["fallback.txt"],
          network: "none",
          processMode: "none",
          checkpointScope: ["fallback.txt"],
          idempotence: "non_replayable"
        })
      },
      async execute(request) {
        const startedAt = new Date().toISOString();
        await writeFile(path.join(workspace, "fallback.txt"), "fallback", "utf8");
        return {
          callId: request.callId,
          ok: true,
          output: "fallback",
          outcome: { status: "succeeded", output: "fallback", diagnosticCodes: [] },
          observedEffects: ["filesystem.write"],
          actualEffects: ["filesystem.write"],
          workspaceDelta: { added: ["fallback.txt"], modified: [], deleted: [] },
          artifacts: [],
          diagnostics: [],
          evidence: [],
          startedAt,
          completedAt: new Date().toISOString()
        };
      }
    });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("structured", "write", {
          path: "structured.txt",
          content: "structured"
        })]),
        fakeToolTurn([fakeToolCall("fallback", "open_writer", {})]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", {
          message: "Both writes completed."
        })])
      ]),
      tools,
      execution,
      store: new SegmentedJsonlStore({ rootDir: path.join(root, "state") }),
      storeRootDir: path.join(root, "state"),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Run both structured and open writers."
    });
    const outcome = await runtime.waitForOutcome(session.sessionId);
    expect(outcome).toMatchObject({ kind: "needs_input", requestId: "done" });

    const statusCalls = execute.mock.calls.filter(([request]) =>
      /(?:^|[\\/])git(?:\.exe)?$/iu.test(request.command.executable)
      && request.command.args?.includes("status"));
    expect(statusCalls).toHaveLength(2);
    expect(await readFile(path.join(workspace, "structured.txt"), "utf8")).toBe("structured");
    expect(await readFile(path.join(workspace, "fallback.txt"), "utf8")).toBe("fallback");
  });
});
