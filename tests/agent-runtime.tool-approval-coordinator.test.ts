import type {
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect
} from "../packages/agent-protocol/src/index.js";
import { ToolApprovalCoordinator } from "../packages/agent-runtime/src/tool-approval-coordinator.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";
import { describe, expect, it, vi } from "vitest";

const call: ModelToolCall = {
  id: "terminal-call",
  name: "terminal_tool",
  arguments: {}
};

function descriptor(
  possibleEffects: ToolEffect[],
  approval: ToolDescriptor["approval"] = "prompt",
  maximumEffects?: ToolEffect[]
): ToolDescriptor {
  return {
    name: call.name,
    description: "Test terminal protocol approval.",
    inputSchema: { type: "object" },
    possibleEffects,
    ...(maximumEffects ? { maximumEffects } : {}),
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval,
    idempotent: true,
    timeoutMs: 5_000
  };
}

function plan(exactEffects: ToolEffect[], network: ToolCallPlan["network"] = "none"): ToolCallPlan {
  return {
    exactEffects,
    readPaths: [],
    writePaths: [],
    network,
    processMode: "none",
    checkpointScope: [],
    idempotence: "read_only"
  };
}

async function decision(
  tool: ToolDescriptor,
  callPlan: ToolCallPlan
): Promise<{ result: "allow" | "deny" | "always_allow"; emit: ReturnType<typeof vi.fn> }> {
  const emit = vi.fn(async () => ({}));
  const coordinator = new ToolApprovalCoordinator({
    runtime: { permissionMode: "deny" } as never,
    emit: emit as never
  });
  const session: RuntimeSession = runtimeSessionFixture();
  const result = await coordinator.decision(session, {
    call,
    modelTurn: { turnId: 1, effectRevision: 1 },
    descriptor: tool,
    plan: callPlan
  }, new AbortController().signal);
  return { result, emit };
}

describe("deny-mode internal terminal approval", () => {
  it.each([
    ["completion", ["outcome.propose"]],
    ["input request", ["outcome.request_input"]],
    ["combined internal protocol", ["outcome.propose", "outcome.request_input"]]
  ] as const)("allows a pure %s tool without prompting", async (_label, effects) => {
    const outcome = await decision(
      descriptor([...effects]),
      plan([...effects])
    );

    expect(outcome.result).toBe("allow");
    expect(outcome.emit).not.toHaveBeenCalled();
  });

  it.each([
    ["external", ["filesystem.read"]],
    ["mixed", ["outcome.propose", "filesystem.read"]]
  ] as const)("continues to deny a %s tool", async (_label, effects) => {
    const outcome = await decision(
      descriptor([...effects]),
      plan([...effects])
    );

    expect(outcome.result).toBe("deny");
    expect(outcome.emit).not.toHaveBeenCalled();
  });

  it("denies external authority in either the maximum or planned effects", async () => {
    const maximum = await decision(
      descriptor(["outcome.propose"], "prompt", ["outcome.propose", "filesystem.write"]),
      plan(["outcome.propose"])
    );
    const planned = await decision(
      descriptor(["outcome.propose"]),
      plan(["outcome.propose", "network"], "full")
    );

    expect(maximum.result).toBe("deny");
    expect(planned.result).toBe("deny");
    expect(maximum.emit).not.toHaveBeenCalled();
    expect(planned.emit).not.toHaveBeenCalled();
  });

  it("keeps descriptor approval=deny authoritative for a pure terminal tool", async () => {
    const outcome = await decision(
      descriptor(["outcome.request_input"], "deny"),
      plan(["outcome.request_input"])
    );

    expect(outcome.result).toBe("deny");
    expect(outcome.emit).not.toHaveBeenCalled();
  });
});
