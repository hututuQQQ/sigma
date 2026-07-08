import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planValidation, planValidationCommandSpecs } from "../packages/agent-core/src/harness/validation-planner.js";
import { createValidationPlan, discoverProjects } from "../packages/agent-core/src/index.js";

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
        "if command -v uv >/dev/null 2>&1; then uv run pytest -q; else python -m pytest -q; fi"
      ])
    );
  });

  it("does not add project-level validation when auto mode has no changed files", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n", "utf8");

    const specs = await planValidationCommandSpecs({ workspacePath: dir });

    expect(specs).toEqual([]);
  });

  it("preserves explicit commands without requiring changed files", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");

    const specs = await planValidationCommandSpecs({ workspacePath: dir, configuredCommands: ["pnpm test"] });

    expect(specs).toEqual([{ source: "configured", command: "pnpm test", relatedFiles: [] }]);
  });

  it("does not add project-level validation for docs-only changes", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");

    const specs = await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["README.md"] });

    expect(specs).toEqual([]);
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

    const specs = await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["src/main.ts"] });
    const commands = specs.map((spec) => spec.command);

    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm test; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm run build; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(commands).toContain(
      "if [ -f ./node_modules/.bin/tsc ]; then ./node_modules/.bin/tsc --noEmit; elif [ -f ./node_modules/.bin/tsc.cmd ]; then ./node_modules/.bin/tsc.cmd --noEmit; elif command -v tsc >/dev/null 2>&1; then tsc --noEmit; else echo 'tsc not found for validation' >&2; exit 127; fi"
    );
    expect(commands.join("\n")).not.toContain("npx");
  });

  it("targets the nested pnpm package affected by a changed file", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await mkdir(path.join(dir, "packages", "app"), { recursive: true });
    await writeFile(
      path.join(dir, "packages", "app", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
      "utf8"
    );

    const plan = await createValidationPlan({ workspacePath: dir, changedFiles: ["packages/app/src/main.ts"] });
    const commands = plan.candidates.map((candidate) => candidate.command);

    expect(plan.candidates.every((candidate) => candidate.cwd === path.join(dir, "packages", "app"))).toBe(true);
    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm run typecheck; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm test; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(plan.candidates[0]).toMatchObject({
      scope: "package",
      kind: "typecheck",
      cost: expect.any(String),
      reason: expect.any(String),
      analyzerHints: expect.arrayContaining(["typescript"])
    });

    const specs = await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["packages/app/src/main.ts"] });
    expect(specs[0].cwd).toBe(path.join(dir, "packages", "app"));
  });

  it("infers Node package manager from packageManager when no lockfile exists", async () => {
    const dir = await tempWorkspace();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ packageManager: "bun@1.2.0", scripts: { build: "tsc -p tsconfig.json" } }),
      "utf8"
    );

    const commands = (await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["package.json"] })).map(
      (spec) => spec.command
    );

    expect(commands).toContain("if command -v bun >/dev/null 2>&1; then bun run build; else echo 'bun not found for validation' >&2; exit 127; fi");
  });

  it("prefers lockfiles over packageManager when inferring package manager", async () => {
    const dir = await tempWorkspace();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ packageManager: "bun@1.2.0", scripts: { test: "vitest run" } }),
      "utf8"
    );
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const commands = (await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["package.json"] })).map(
      (spec) => spec.command
    );

    expect(commands).toContain("if command -v pnpm >/dev/null 2>&1; then pnpm test; else echo 'pnpm not found for validation' >&2; exit 127; fi");
    expect(commands.join("\n")).not.toContain("bun");
  });

  it("plans Go and Rust project checks", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "go.mod"), "module example.com/app\n", "utf8");
    await writeFile(path.join(dir, "Cargo.toml"), "[package]\nname='app'\nversion='0.1.0'\n", "utf8");

    const commands = (await planValidationCommandSpecs({ workspacePath: dir, changedFiles: ["main.go", "src/lib.rs"] })).map(
      (spec) => spec.command
    );

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

  it("discovers project roots and exposes skipped fallback reasons", async () => {
    const dir = await tempWorkspace();
    const discovery = await discoverProjects({ workspacePath: dir, changedFiles: ["notes.txt"] });
    const plan = await planValidation({ workspacePath: dir, changedFiles: ["notes.txt"] });

    expect(discovery.roots).toEqual([]);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.map((item) => item.reason).join("\n")).toContain("No project metadata discovered");
  });

  it("creates structured validation candidates with configured commands first", async () => {
    const dir = await tempWorkspace();
    await writeFile(path.join(dir, "go.mod"), "module example.com/app\n", "utf8");

    const plan = await createValidationPlan({
      workspacePath: dir,
      configuredCommands: ["make verify"],
      changedFiles: ["main.go"]
    });

    expect(plan.candidates[0]).toMatchObject({
      command: "make verify",
      scope: "project",
      kind: "manual-check",
      reason: expect.stringContaining("User-configured")
    });
    expect(plan.candidates.some((candidate) => candidate.command.includes("go test ./..."))).toBe(true);
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
