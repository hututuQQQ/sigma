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
    const codexRuntimeSource = await readFile(path.join(result.harborRuntimeDir, "codex_harbor_agent.py"), "utf8");
    const sandboxCompose = await readFile(result.sandboxComposePath, "utf8");
    const proxyCompose = await readFile(result.proxyComposePath, "utf8");
    const aptNetworkConfig = await readFile(result.aptNetworkConfigPath, "utf8");
    const aptRetryWrapper = await readFile(result.aptRetryWrapperPath, "utf8");
    const readme = await readFile(path.join(result.harborRuntimeDir, "README.md"), "utf8");
    const packagedFiles = await readdir(result.harborRuntimeDir);

    expect(runtimeSource).toContain("class SigmaCliHarborAgent(BaseAgent):");
    expect(codexRuntimeSource).toContain("class PortableCodex(Codex):");
    expect(codexRuntimeSource).not.toContain("npm install");
    expect(codexRuntimeSource).not.toContain("nvm install");
    expect(runtimeSource).not.toContain(removedHarborPackageName);
    expect(runtimeSource).toContain(portableAgentImportPath.split(":")[1]);
    expect(sandboxCompose).toContain("SYS_ADMIN");
    expect(sandboxCompose).toContain("seccomp=unconfined");
    expect(proxyCompose).toContain("host.docker.internal:host-gateway");
    expect(proxyCompose).toContain("SIGMA_CONTAINER_HTTPS_PROXY");
    expect(proxyCompose).toContain("80sigma-network-retries");
    expect(proxyCompose).toContain("SIGMA_CONTAINER_APT_RETRY_WRAPPER");
    expect(aptNetworkConfig).toContain('Acquire::Retries "5";');
    expect(aptRetryWrapper).toContain("Transient APT network failure");
    expect(aptRetryWrapper).toContain("502[[:space:]]+Bad Gateway");
    expect(aptRetryWrapper).toContain('exit "$status"');
    expect(path.isAbsolute(result.agentCliTarball)).toBe(true);
    expect(packagedFiles.some((name) => name.endsWith(".json"))).toBe(false);
    expect(readme).not.toContain(removedHarborPackageName);
    expect(readme).not.toContain(removedHarborDirectoryName);
    expect(readme).toContain("pnpm package:agent-cli");
    expect(readme).toContain("SigmaFormalRunPreregistration");
    expect(readme).toContain("pnpm bench:tb:formal");
    expect(readme).not.toContain("deepseek");
  });
});
