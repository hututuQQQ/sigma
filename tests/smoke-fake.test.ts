import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeFinalTurn,
  fakeProcessValidationTurn,
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";
import { linuxPackageSmokeResponses } from "../scripts/ci/linux-package-fake-model-smoke.mjs";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";
import { registerContentValidator, validationTurn } from "./helpers/content-validator.js";

describe("generic fake model smoke", () => {
  it("keeps validation calls on the public command contract", () => {
    const turn = fakeProcessValidationTurn("validate", "hello.txt", "hello world")();

    expect(turn.message.toolCalls).toEqual([{
      id: "validate",
      name: "validate",
      arguments: {
        executable: "./pnpm",
        args: ["run", "verify-smoke", "hello.txt", "hello world"]
      }
    }]);
    expect(JSON.stringify(turn)).not.toContain("access");
    expect(JSON.stringify(turn)).not.toContain("writePaths");
  });

  it("keeps the Linux package smoke validation sequence typed and completion-ready", () => {
    const turns = linuxPackageSmokeResponses().map((turn) => typeof turn === "function" ? turn() : turn);
    const calls = turns.flatMap((turn) => turn.message.toolCalls ?? []);

    expect(calls.map((call) => call.name)).toEqual(["write", "validate", "validate"]);
    expect(calls[1]?.arguments).toEqual({ executable: "node", args: ["--check", "hello.js"] });
    expect(calls[2]?.arguments).toMatchObject({ executable: "node", args: ["-e", expect.stringContaining("throw new Error")] });
    expect(JSON.stringify(calls)).not.toContain("access");
    expect(turns[3]?.message.content).toBe("Portable package fake-model smoke completed.");
    expect(JSON.parse(turns[4]?.message.content ?? "{}")).toEqual({ verdict: "approved", findings: [] });
  });

  it("drives normal multi-turn tool execution without task-identity branching", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-generic-smoke-"));
    await writeFile(path.join(workspace, "input.txt"), "before\n", "utf8");
    const gateway = new SmokeFakeGateway([
      fakeToolTurn([fakeToolCall("read-input", "read", { path: "input.txt" })]),
      fakeToolTurn([fakeToolCall("edit-input", "edit", { path: "input.txt", oldText: "before", newText: "after" })]),
      validationTurn("validate-input", [{ path: "input.txt", expected: "after\n" }]),
      fakeFinalTurn("The requested change is complete.")
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry())),
      reviewer: createApprovingReviewer(),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Inspect the workspace and make the requested change.", mode: "change" });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readFile(path.join(workspace, "input.txt"), "utf8")).resolves.toBe("after\n");
    expect(gateway.requests).toHaveLength(4);
  });
});
