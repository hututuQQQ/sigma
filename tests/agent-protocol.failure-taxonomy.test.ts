import { describe, expect, it } from "vitest";
import {
  FAILURE_TAXONOMY_VERSION,
  INFRASTRUCTURE_FAILURE_LIMIT,
  classifyInfrastructureFailureCodesV1
} from "../packages/agent-protocol/src/index.js";

describe("infrastructure failure taxonomy v1", () => {
  it("classifies stable codes shared by the runtime and evaluator", () => {
    expect(classifyInfrastructureFailureCodesV1([
      "sandbox_reparse_target_unresolvable",
      "sandbox_unavailable"
    ])).toEqual({
      taxonomyVersion: FAILURE_TAXONOMY_VERSION,
      family: "execution_sandbox",
      codes: ["sandbox_reparse_target_unresolvable", "sandbox_unavailable"]
    });
    expect(INFRASTRUCTURE_FAILURE_LIMIT).toBe(3);
  });

  it("does not infer infrastructure failure from policy or process status", () => {
    expect(classifyInfrastructureFailureCodesV1([
      "policy_denied",
      "exit_code=125",
      "something happened: sandbox_reparse_target_unresolvable"
    ])).toBeUndefined();
  });

  it("selects one family deterministically and normalizes code suffixes", () => {
    expect(classifyInfrastructureFailureCodesV1([
      " BROKER_TIMEOUT:poll ",
      "sandbox_unavailable",
      "broker_timeout"
    ])).toEqual({
      taxonomyVersion: 1,
      family: "execution_timeout",
      codes: ["broker_timeout"]
    });
  });
});
