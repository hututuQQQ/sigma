import { describe, expect, it } from "vitest";
import { executionCommandSemantics } from "../packages/agent-tools/src/execution-command-semantics.js";

describe("execution command semantics", () => {
  const cases = [
    ["node", ["--test", "src/app.test.mjs"], "unit", "test"],
    ["python", ["-m", "unittest", "discover"], "unit", "test"],
    ["go", ["test", "./..."], "unit", "test"],
    ["cargo", ["+stable", "test", "--locked"], "unit", "test"],
    ["dotnet", ["test"], "unit", "test"],
    ["mvn", ["verify"], "integration", "test"],
    ["gradle", ["integrationTest"], "integration", "test"],
    ["pnpm", ["run", "typecheck"], "typecheck", "build"],
    ["pnpm", ["--filter", "workspace-package", "test"], "unit", "test"],
    ["node", ["test_settings.js"], "unit", "test"],
    ["node", ["verify.mjs"], "acceptance", "custom"]
  ] as const;

  for (const [executable, args, claimKind, purpose] of cases) {
    it(`classifies ${executable} ${args.join(" ")}`, () => {
      expect(executionCommandSemantics({ executable, args, validation: true })).toMatchObject({
        claimKind, purpose, safelyParsed: true
      });
    });
  }

  it("treats substantive custom validation as acceptance but capability probes as probes", () => {
    expect(executionCommandSemantics({
      executable: "node", args: ["-e", "JSON.parse('{}')"], validation: true
    })).toMatchObject({ claimKind: "acceptance", purpose: "custom" });
    expect(executionCommandSemantics({
      executable: "node", args: ["--version"], validation: true
    })).toMatchObject({ claimKind: "probe", purpose: "probe" });
    expect(executionCommandSemantics({
      executable: "custom-validator", args: [], validation: true
    })).toMatchObject({ claimKind: "probe", purpose: "probe" });
  });

  it("parses one simple shell invocation and refuses compound shell semantics", () => {
    expect(executionCommandSemantics({
      executable: "bash", args: [], shellCommand: "node --test src/app.test.mjs", validation: true
    })).toMatchObject({ executable: "node", claimKind: "unit", safelyParsed: true });
    expect(executionCommandSemantics({
      executable: "bash", args: [], shellCommand: "node --test src/app.test.mjs && echo ok", validation: true
    })).toMatchObject({ claimKind: "probe", purpose: "probe", safelyParsed: false });
  });
});
