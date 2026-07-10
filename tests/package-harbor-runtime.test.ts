import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageHarborRuntime } from "../scripts/package-harbor-runtime.mjs";
import {
  portableAgentImportPath,
  removedHarborDirectoryName,
  removedHarborPackageName
} from "../scripts/bench-common.mjs";

describe("package-harbor-runtime", () => {
  it("creates a portable Harbor runtime with direct CLI configs", async () => {
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "sigma-harbor-runtime-"));
    const agentCliTarball = path.join(artifactsDir, "agent-cli-linux-x64.tgz");
    await writeFile(agentCliTarball, "fixture", "utf8");
    const result = await packageHarborRuntime({ artifactsDir, agentCliTarball });

    const runtimeSource = await readFile(path.join(result.harborRuntimeDir, "sigma_harbor_agent.py"), "utf8");
    const k5Config = JSON.parse(await readFile(path.join(result.harborRuntimeDir, "jobconfig.deepseek.k5.json"), "utf8"));
    const readme = await readFile(path.join(result.harborRuntimeDir, "README.md"), "utf8");

    expect(runtimeSource).toContain("class SigmaCliHarborAgent(BaseAgent):");
    expect(runtimeSource).not.toContain(removedHarborPackageName);
    expect(k5Config.agents[0].name).toBe(portableAgentImportPath);
    expect(JSON.stringify(k5Config)).not.toContain(removedHarborPackageName);
    expect(k5Config.agents[0].kwargs.agent_cli_tarball).toBe(result.agentCliTarball);
    expect(path.isAbsolute(k5Config.agents[0].kwargs.agent_cli_tarball)).toBe(true);
    expect(readme).not.toContain(removedHarborPackageName);
    expect(readme).not.toContain(removedHarborDirectoryName);
    expect(readme).toContain("pnpm package:agent-cli");
    expect(readme).toContain('PYTHONPATH="$PWD/.artifacts/harbor-runtime"');
    expect(readme).toContain("harbor run --config .artifacts/harbor-runtime/jobconfig.deepseek.k5.json");
  });
});
