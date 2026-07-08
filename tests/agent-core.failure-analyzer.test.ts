import { describe, expect, it } from "vitest";
import { analyzeFailure, failureInputFromHarnessResult } from "../packages/agent-core/src/index.js";
import type { HarnessCommandResult } from "../packages/agent-core/src/index.js";

function harnessFailure(overrides: Partial<HarnessCommandResult>): HarnessCommandResult {
  return {
    kind: "validation",
    source: "configured",
    command: "pnpm test",
    attempt: 1,
    exit_code: 1,
    stdout_tail: "",
    stderr_tail: "",
    related_files: [],
    timeout_sec: 60,
    duration_ms: 10,
    message: "failed",
    ...overrides
  };
}

describe("FailureAnalyzer", () => {
  it("classifies TypeScript compiler diagnostics as compile errors", () => {
    const analysis = analyzeFailure({
      ok: false,
      command: "pnpm exec tsc --noEmit",
      stderr: "src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      exitCode: 2
    });

    expect(analysis).toMatchObject({
      category: "compile_error",
      exitCode: 2
    });
    expect(analysis?.primaryMessage).toContain("TS2322");
  });

  it("classifies pytest assertion output as test failure", () => {
    const analysis = analyzeFailure({
      ok: false,
      command: "pytest tests/test_app.py",
      stdout: "FAILED tests/test_app.py::test_total - AssertionError: expected 3",
      exitCode: 1
    });

    expect(analysis?.category).toBe("test_failure");
    expect(analysis?.suggestedNextAction).toContain("failing test");
  });

  it("classifies go test failures", () => {
    const analysis = analyzeFailure({
      ok: false,
      command: "go test ./...",
      stdout: "--- FAIL: TestTotal (0.00s)\n    total_test.go:10: expected 3 got 2\nFAIL",
      exitCode: 1
    });

    expect(analysis?.category).toBe("test_failure");
  });

  it("classifies cargo test failures", () => {
    const analysis = analyzeFailure({
      ok: false,
      command: "cargo test",
      stdout: "test result: FAILED. 1 passed; 1 failed",
      exitCode: 101
    });

    expect(analysis?.category).toBe("test_failure");
  });

  it("classifies timeouts, missing commands, and segmentation faults", () => {
    expect(analyzeFailure({ ok: false, command: "pnpm test", timedOut: true, exitCode: 124 })?.category).toBe(
      "timeout"
    );
    expect(analyzeFailure({ ok: false, command: "does-not-exist", stderr: "command not found", exitCode: 127 })?.category).toBe(
      "missing_tool"
    );
    expect(analyzeFailure({ ok: false, command: "./app", stderr: "Segmentation fault", exitCode: 139 })?.category).toBe(
      "segmentation_fault"
    );
  });

  it("builds analyzer input from harness command results", () => {
    const analysis = analyzeFailure(failureInputFromHarnessResult(harnessFailure({
      command: "pytest",
      stdout_tail: "FAILED test_example.py::test_example - AssertionError",
      stderr_tail: "",
      exit_code: 1
    })));

    expect(analysis).toMatchObject({
      category: "test_failure",
      relatedCommand: "pytest",
      exitCode: 1
    });
  });

  it("uses unknown for failed commands without a recognizable pattern", () => {
    const analysis = analyzeFailure({
      ok: false,
      command: "custom-check",
      stdout: "custom check rejected the output",
      exitCode: 3
    });

    expect(analysis?.category).toBe("unknown");
    expect(analysis?.suggestedNextAction).toContain("Inspect the command output");
  });
});
