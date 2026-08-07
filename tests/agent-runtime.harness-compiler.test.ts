import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HARNESS_COMPILER_VERSION,
  canonicalHarnessJson,
  compileHarnessBuild,
  type HarnessCompilerInput
} from "../packages/agent-runtime/src/harness-compiler.js";
import { strictReviewProfileFixture } from "./testkit/agent-profile-fixture.js";

function input(): HarnessCompilerInput {
  return {
    provider: "fixture-provider",
    model: "fixture-model",
    reasoningEffort: "max",
    modelRole: "orchestrator",
    runMode: "change",
    modelCapabilities: {
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      tools: true,
      parallelTools: true,
      reasoning: true,
      structuredOutput: true,
      promptCache: true,
      tokenizer: "provider"
    },
    runtimeCapabilities: {
      tools: [{
        name: "read",
        description: "Read a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }],
      executionMode: "sandboxed",
      writeScope: "workspace",
      managedEnvironment: false,
      network: "full",
      interactiveApprovals: false,
      environment: {
        platform: "linux",
        arch: "x64",
        defaultShell: "bash",
        availableShells: ["bash"],
        availableRuntimeCommands: ["node"],
        executionCapabilitiesVerified: true,
        directExecutableResolution: true,
        executionMode: "sandboxed",
        writeScope: "workspace",
        pathSeparator: "/"
      }
    },
    resolvedAgentProfile: strictReviewProfileFixture().profile
  };
}

describe("Harness identity compiler", () => {
  it("builds a deterministic, deeply frozen identity without activating policies", () => {
    const first = compileHarnessBuild(input());
    const second = compileHarnessBuild(structuredClone(input()));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      compilerVersion: HARNESS_COMPILER_VERSION,
      policyPackIds: ["sigma.runtime-default.identity.v1"],
      activation: "inspection_only",
      modifiesRuntime: false,
      promptPolicy: { mode: "runtime_default", modifiesPrompt: false },
      toolPolicy: {
        mode: "runtime_default",
        modifiesToolSurface: false,
        initialTools: ["read"]
      },
      contextPolicy: { mode: "runtime_default", modifiesContext: false },
      observationPolicy: { mode: "runtime_default", modifiesObservations: false }
    });
    expect(first.digest).toBe(
      createHash("sha256").update(first.canonicalJson).digest("hex")
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.subject)).toBe(true);
    expect(Object.isFrozen(first.toolPolicy.initialTools)).toBe(true);
  });

  it("changes identity when a subject, profile, or exact tool schema changes", () => {
    const baseline = compileHarnessBuild(input());
    const analyze = input();
    analyze.runMode = "analyze";
    const profile = input();
    profile.resolvedAgentProfile = {
      ...profile.resolvedAgentProfile,
      toolDeny: ["read"]
    };
    const schema = input();
    schema.runtimeCapabilities = {
      ...schema.runtimeCapabilities,
      tools: [{
        ...schema.runtimeCapabilities.tools[0]!,
        description: "Read one workspace file."
      }]
    };

    expect(compileHarnessBuild(analyze).digest).not.toBe(baseline.digest);
    expect(compileHarnessBuild(profile).digest).not.toBe(baseline.digest);
    const changedSchema = compileHarnessBuild(schema);
    expect(changedSchema.digest).not.toBe(baseline.digest);
    expect(changedSchema.toolPolicy.initialToolDefinitionsDigest)
      .not.toBe(baseline.toolPolicy.initialToolDefinitionsDigest);

    const environment = input();
    environment.runtimeCapabilities = {
      ...environment.runtimeCapabilities,
      environment: { ...environment.runtimeCapabilities.environment, arch: "arm64" }
    };
    const changedEnvironment = compileHarnessBuild(environment);
    expect(changedEnvironment.digest).not.toBe(baseline.digest);
    expect(changedEnvironment.promptPolicy.runtimeEnvironmentDigest)
      .not.toBe(baseline.promptPolicy.runtimeEnvironmentDigest);
  });

  it("rejects benchmark, task, and other undeclared compiler inputs", () => {
    expect(() => compileHarnessBuild({
      ...input(),
      taskId: "sealed-task"
    } as HarnessCompilerInput)).toThrow(/invalid field set/u);
    expect(() => compileHarnessBuild({
      ...input(),
      runtimeCapabilities: {
        ...input().runtimeCapabilities,
        benchmark: "sealed-suite"
      }
    } as HarnessCompilerInput)).toThrow(/runtime capabilities.*invalid field set/u);
  });

  it("canonicalizes object keys while preserving ordered arrays", () => {
    expect(canonicalHarnessJson({ z: 1, a: { y: 2, x: [3, 1] } }))
      .toBe('{"a":{"x":[3,1],"y":2},"z":1}');
  });
});
