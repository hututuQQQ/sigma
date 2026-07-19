import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallPlan } from "../packages/agent-protocol/src/index.js";
import { checkpointCreatePolicy } from "../packages/agent-runtime/src/tool-transaction-support.js";

function processPlan(workspace: string): ToolCallPlan {
  return {
    exactEffects: ["process.spawn", "filesystem.write"],
    readPaths: ["."],
    writePaths: ["packages/app/node_modules", "packages/app/dist/result.js"],
    network: "none",
    processMode: "pipe",
    checkpointScope: ["."],
    idempotence: "non_replayable",
    executionIntent: {
      invocation: { executable: "tool", args: [], cwd: "packages/app" },
      access: "write",
      expectedChanges: ["packages/app/node_modules", "packages/app/dist/result.js"],
      network: "none",
      purpose: "build"
    },
    executionCapability: {
      profileId: "generic-build",
      traversalRoots: ["packages/app"],
      workspaceReadRoots: ["."],
      dependencyRoots: [
        "node_modules",
        "node_modules",
        path.resolve(workspace, "..", "external-cache")
      ],
      runtimeRoots: [],
      writeRoots: ["."],
      tempRoots: [],
      network: "none",
      backend: "native"
    }
  };
}

describe("checkpoint capture policy", () => {
  it("derives reproducible roots from frozen capabilities relative to invocation cwd", () => {
    const workspace = path.resolve("workspace-policy-test");
    expect(checkpointCreatePolicy(workspace, processPlan(workspace))).toEqual({
      reproducibleRootPaths: ["packages/app/node_modules"],
      explicitDeliverablePaths: ["packages/app/dist/result.js"]
    });
  });

  it("does not invent compact roots for ordinary filesystem mutations", () => {
    const plan = processPlan(path.resolve("workspace-policy-test"));
    delete plan.executionCapability;
    expect(checkpointCreatePolicy(path.resolve("workspace-policy-test"), plan)).toEqual({
      reproducibleRootPaths: [],
      explicitDeliverablePaths: ["packages/app/node_modules", "packages/app/dist/result.js"]
    });
  });

  it("preserves a specifically delivered child below a dependency root", () => {
    const workspace = path.resolve("workspace-policy-test");
    const plan = processPlan(workspace);
    plan.writePaths = ["packages/app/node_modules/custom/output.js"];
    expect(checkpointCreatePolicy(workspace, plan)).toEqual({
      reproducibleRootPaths: ["packages/app/node_modules"],
      explicitDeliverablePaths: ["packages/app/node_modules/custom/output.js"]
    });
  });
});
