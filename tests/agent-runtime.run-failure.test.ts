import { describe, expect, it } from "vitest";
import { runtimeFailureOutcome } from "../packages/agent-runtime/src/runtime-run.js";

function deadlineReason(): Error {
  return Object.assign(new Error("run deadline elapsed"), {
    name: "TimeoutError",
    code: "run_deadline"
  });
}

describe("runtime failure classification", () => {
  it("does not relabel a concrete protocol failure that races with the deadline", () => {
    const controller = new AbortController();
    controller.abort(deadlineReason());
    const protocolFailure = Object.assign(new Error("terminal schema is invalid"), {
      code: "terminal_protocol_invalid"
    });

    expect(runtimeFailureOutcome(protocolFailure, controller.signal)).toEqual({
      kind: "recoverable_failure",
      code: "terminal_protocol_invalid",
      message: "terminal schema is invalid"
    });
  });

  it("maps the controller's own deadline reason to budget exhaustion", () => {
    const controller = new AbortController();
    const reason = deadlineReason();
    controller.abort(reason);

    expect(runtimeFailureOutcome(reason, controller.signal)).toEqual({
      kind: "recoverable_failure",
      code: "budget_exhausted",
      message: "run deadline elapsed"
    });
  });
});
