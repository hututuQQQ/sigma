import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
  it("creates a policy-free portable runtime for preregistered JobConfigs", async () => {
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "sigma-harbor-runtime-"));
    const agentCliTarball = path.join(artifactsDir, "agent-cli-linux-x64.tgz");
    await writeFile(agentCliTarball, "fixture", "utf8");
    const result = await packageHarborRuntime({ artifactsDir, agentCliTarball });

    const runtimeSource = await readFile(path.join(result.harborRuntimeDir, "sigma_harbor_agent.py"), "utf8");
    const sandboxCompose = await readFile(result.sandboxComposePath, "utf8");
    const readme = await readFile(path.join(result.harborRuntimeDir, "README.md"), "utf8");
    const packagedFiles = await readdir(result.harborRuntimeDir);

    expect(runtimeSource).toContain("class SigmaCliHarborAgent(BaseAgent):");
    expect(runtimeSource).not.toContain(removedHarborPackageName);
    expect(runtimeSource).toContain(portableAgentImportPath.split(":")[1]);
    expect(sandboxCompose).toContain("SYS_ADMIN");
    expect(sandboxCompose).toContain("seccomp=unconfined");
    expect(path.isAbsolute(result.agentCliTarball)).toBe(true);
    expect(packagedFiles.some((name) => name.endsWith(".json"))).toBe(false);
    expect(readme).not.toContain(removedHarborPackageName);
    expect(readme).not.toContain(removedHarborDirectoryName);
    expect(readme).toContain("pnpm package:agent-cli");
    expect(readme).toContain("SigmaFormalRunPreregistrationV1");
    expect(readme).toContain("pnpm bench:tb:formal");
    expect(readme).not.toContain("deepseek");
  });
});
