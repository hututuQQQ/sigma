import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planValidationCommandSpecs } from "../packages/agent-core/src/harness/validation-planner.js";

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-validation-planner-"));
}

describe("validation planner", () => {
  it("plans Python pytest with uv preference", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\npythonpath=['src']\n[tool.uv]\n", "utf8");
    await writeFile(path.join(dir, "uv.lock"), "", "utf8");

    const specs = await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["pkg/a.py"] });

    expect(specs.map((spec) => spec.command)).toEqual(
      expect.arrayContaining([
        "python -m py_compile pkg/a.py",
        "if command -v uv >/dev/null 2>&1; then uv run pytest -q; else echo 'uv not found for validation' >&2; exit 127; fi"
      ])
    );
  });

  it("plans Node package scripts and TypeScript checks", async () => {
    const dir = await tempWorkspace();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", build: "tsc -p tsconfig.json" },
        devDependencies: { typescript: "^5.0.0" }
      }),
      "utf8"
    );
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf8");

    const specs = await planValidationCommandSpecs({ workspacePath: dir });
    const commands = specs.map((spec) => spec.command);

    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm test; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm run build; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm exec tsc --noEmit; else echo 'pnpm not found for validation' >&2; exit 127; fi");
  });

  it("plans Go and Rust project checks", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "go.mod"), "module example.com/app\n", "utf8");
    await writeFile(path.join(dir, "Cargo.toml"), "[package]\nname='app'\nversion='0.1.0'\n", "utf8");

    const commands = (await planValidationCommandSpecs({ workspacePath: dir })).map((spec) => spec.command);

    expect(commands).toContain("if command -v go >/dev/null 2>&1; then go test ./...; else echo 'go not found for validation' >&2; exit 127; fi");
    expect(commands).toContain("if command -v cargo >/dev/null 2>&1; then cargo test --quiet; else echo 'cargo not found for validation' >&2; exit 127; fi");
  });

  it("keeps explicit command precedence and dedupes commands", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");

    const specs = await planValidationCommandSpecs({
      workspacePath: dir,
      configuredCommands: ["npm test", "npm test"],
      changedFiles: ["main.js"]
    });

    expect(specs[0]).toMatchObject({ source: "configured", command: "npm test" });
    expect(specs.map((spec) => spec.command).filter((command) => command === "npm test")).toHaveLength(1);
  });

  it("quotes changed file paths and bounds command count", async () => {
    const dir = await tempWorkspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    const changedFiles = Array.from({ length: 30 }, (_, index) => `src/file ${index}.py`);

    const specs = await planValidationCommandSpecs({ workspacePath: dir, changedFiles, maxCommands: 5 });

    expect(specs).toHaveLength(5);
    expect(specs[0].command).toBe("python -m py_compile 'src/file 0.py'");
  });
});
