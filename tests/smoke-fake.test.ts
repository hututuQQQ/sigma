import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { fakeFinalTurn, fakeToolCall, fakeToolTurn, SmokeFakeGateway } from "../scripts/smoke-fake-model.mjs";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";
import { registerContentValidator, validationTurn } from "./helpers/content-validator.js";

describe("generic fake model smoke", () => {
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
