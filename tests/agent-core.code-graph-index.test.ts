import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../packages/agent-ai/src/index.js";
import {
  buildCodeGraphIndex,
  createDefaultToolRegistry,
  executeRepoQueryTool,
  generateRepoMap,
  getCodeGraphIndexForTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-code-graph-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 5,
      maxToolOutputChars: 12000,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>(), contextIndexes: new Map<string, unknown>() },
      alwaysAllowTools: new Set<string>()
    }
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("CodeGraphIndex", () => {
  it("builds a TypeScript import graph and test-to-source relation", async () => {
    const { dir } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "math.ts"), "export function addNumbers() { return 1; }\n", "utf8");
    await writeFile(path.join(dir, "src", "index.ts"), "import { addNumbers } from './math';\nexport { addNumbers };\n", "utf8");
    await writeFile(path.join(dir, "src", "math.test.ts"), "import { addNumbers } from './math';\ntest('addNumbers', () => addNumbers());\n", "utf8");

    const graph = await buildCodeGraphIndex({ workspacePath: dir });

    expect(graph.dependencyEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "src/index.ts", to: "src/math.ts", kind: "import" }),
        expect.objectContaining({ from: "src/math.test.ts", to: "src/math.ts", kind: "test-to-source" })
      ])
    );
    expect(graph.exports).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/math.ts", symbol: "addNumbers" })]));
    expect(graph.testDeclarations).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/math.test.ts", symbol: "addNumbers" })]));
    expect(graph.fileCache["src/math.ts"].hash).toEqual(expect.any(String));
  });

  it("builds Python and Go import graph signals", async () => {
    const { dir } = await workspace();
    await mkdir(path.join(dir, "app"), { recursive: true });
    await writeFile(path.join(dir, "app", "core.py"), "def run_app():\n    return 1\n", "utf8");
    await writeFile(path.join(dir, "app", "main.py"), "from app.core import run_app\nprint(run_app())\n", "utf8");
    await writeFile(path.join(dir, "main.go"), "package main\n\nimport \"fmt\"\nfunc Run() { fmt.Println(\"ok\") }\n", "utf8");

    const graph = await buildCodeGraphIndex({ workspacePath: dir });

    expect(graph.dependencyEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "app/main.py", to: "app/core.py", kind: "import" })
    ]));
    expect(graph.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "main.go", source: "fmt" })
    ]));
    expect(graph.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "main.go", symbol: "Run" }),
      expect.objectContaining({ path: "app/core.py", symbol: "run_app" })
    ]));
  });

  it("invalidates graph cache after mutation", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "index.ts"), "export function beforeGraph() { return 1; }\n", "utf8");
    const before = await getCodeGraphIndexForTool(context);
    const beforeHash = before.fileCache["src/index.ts"].hash;
    const registry = createDefaultToolRegistry();
    try {
      const writeResult = await registry.execute(toolCall("write", "write", {
        path: "src/index.ts",
        content: "export function afterGraph() { return 2; }\n",
        createDirs: true
      }), context);
      expect(writeResult.ok).toBe(true);
      const after = await getCodeGraphIndexForTool(context);
      expect(after.fileCache["src/index.ts"].hash).not.toBe(beforeHash);
      expect(after.definitions).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: "afterGraph" })]));
    } finally {
      await registry.close?.();
    }
  });

  it("repo_query returns graph signals and why_this_file for related sources", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "ledger.ts"), "export function balanceLedger() { return 1; }\n", "utf8");
    await writeFile(path.join(dir, "src", "ledger.test.ts"), "import { balanceLedger } from './ledger';\ntest('balanceLedger', () => balanceLedger());\n", "utf8");

    const result = await executeRepoQueryTool({ query: "src/ledger.test.ts", maxSnippets: 5 }, context);

    expect(result.ok).toBe(true);
    const matches = result.metadata?.matches as Array<{ path: string; graphSignals: string[]; why_this_file: string }>;
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/ledger.ts",
        graphSignals: expect.arrayContaining(["test-source-relation"]),
        why_this_file: expect.stringContaining("Related source")
      })
    ]));
  });

  it("repo map v2 includes roots, configs, exports, tests, and dependency summary", async () => {
    const { dir } = await workspace();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf8");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "thing.ts"), "export class Thing {}\n", "utf8");
    await writeFile(path.join(dir, "src", "thing.test.ts"), "import { Thing } from './thing';\ntest('Thing', () => new Thing());\n", "utf8");

    const repoMap = await generateRepoMap({ workspacePath: dir, maxChars: 12000 });

    expect(repoMap.content).toContain("Repository map generated by Sigma");
    expect(repoMap.content).toContain("Project roots:");
    expect(repoMap.content).toContain("Important config files:");
    expect(repoMap.content).toContain("src/thing.ts");
    expect(repoMap.content).toContain("src/thing.test.ts");
    expect(repoMap.content).toContain("Dependency graph summary:");
  });
});
